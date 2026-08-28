import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { WorkspaceRole } from "@/types/workspace-role";

/**
 * Invitations d'équipe (C14).
 *
 * LE JETON N'EST JAMAIS STOCKÉ. La table ne garde que son empreinte SHA-256 —
 * le même principe qu'`oauth_states` en C8.1. Une lecture de la table ne
 * permettrait donc de rejoindre aucun workspace, et POSTYNC lui-même ne peut
 * pas régénérer un lien déjà émis : il faut en créer un nouveau.
 *
 * L'INVITATION EST LIÉE À UNE ADRESSE. Un lien transmis par erreur à un tiers
 * ne lui sert à rien : `accept_workspace_invitation` compare l'adresse du
 * compte connecté à celle de l'invitation, en base, et refuse si elle diffère.
 * C'est aussi ce qui rend correct le cas « la personne n'a pas encore de
 * compte » : elle s'inscrit avec CETTE adresse, puis accepte.
 *
 * Ce module ne décide de rien : l'autorisation d'inviter reste dans la Server
 * Action, comme partout ailleurs dans le produit.
 */

/** Durée de validité. Assez longue pour un aller-retour humain, pas éternelle. */
export const INVITATION_TTL_DAYS = 7;

/** Rôles qu'une invitation peut accorder. `owner` en est exclu, à dessein. */
export const INVITABLE_ROLES = ["admin", "member"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export type InvitationRow = {
  id: string;
  workspace_id: string;
  email: string;
  role: InvitableRole;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type MemberRow = {
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  displayName: string | null;
  email: string | null;
};

export function isInvitableRole(value: string): value is InvitableRole {
  return (INVITABLE_ROLES as readonly string[]).includes(value);
}

/**
 * Normalisation de l'adresse : minuscules, sans espaces.
 *
 * L'unicité et la comparaison à l'acceptation doivent porter sur la MÊME
 * forme, sinon « Jean@Exemple.fr » et « jean@exemple.fr » créeraient deux
 * invitations dont une seule pourrait être acceptée.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Contrôle volontairement simple : la base porte la contrainte de forme. */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;
}

/** Jeton d'invitation et son empreinte. Le jeton ne sera plus jamais dérivable. */
export function createInvitationToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Comparaison à temps constant de deux empreintes.
 *
 * Utilisée là où l'on compare une empreinte fournie à une empreinte connue :
 * un `===` s'arrête au premier octet différent et laisse fuir, mesure après
 * mesure, la longueur du préfixe correct.
 */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type InviteFailureCode =
  | "invalid_email"
  | "invalid_role"
  | "already_member"
  | "already_invited"
  | "seats_exhausted"
  | "storage_failed";

export type InviteOutcome =
  | {
      ok: true;
      invitationId: string;
      token: string;
      expiresAt: string;
      /**
       * Destinataire et rôle retenus, sous leur forme NORMALISÉE.
       *
       * Renvoyés parce que l'appelant en a besoin pour composer le courriel —
       * et qu'un renvoi ne les connaît pas : il les relit de l'ancienne
       * invitation. Les redemander à l'appelant l'obligerait à refaire la
       * normalisation, donc à la faire différemment un jour.
       */
      email: string;
      role: InvitableRole;
    }
  | { ok: false; code: InviteFailureCode; seats?: number };

export type InviteDeps = {
  /** Client service_role : écritures. */
  db: SupabaseClient;
  /** Sièges autorisés par le plan, propriétaire compris. */
  getSeatQuota: (workspaceId: string) => Promise<number>;
  now?: () => number;
};

/**
 * Crée une invitation.
 *
 * Le quota compte les membres ACTUELS plus les invitations encore vivantes :
 * sans cela, inviter cinq personnes d'un coup sur un plan à trois sièges
 * passerait, et le dépassement n'apparaîtrait qu'à l'acceptation — trop tard
 * pour le dire à qui que ce soit.
 *
 * Le décompte et l'insertion sont indivisibles : ils vivent tous deux dans
 * `create_workspace_invitation`, sous le verrou de la ligne du workspace.
 * Cette fonction ne fait donc plus que préparer le jeton et traduire le
 * verdict de la base.
 */
export async function createInvitation(
  deps: InviteDeps,
  input: {
    workspaceId: string;
    email: string;
    role: string;
    invitedBy: string;
  },
): Promise<InviteOutcome> {
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email)) {
    return { ok: false, code: "invalid_email" };
  }
  if (!isInvitableRole(input.role)) {
    return { ok: false, code: "invalid_role" };
  }

  const now = deps.now ?? Date.now;
  const { db } = deps;

  const quota = await deps.getSeatQuota(input.workspaceId);
  const { token, hash } = createInvitationToken();
  const expiresAt = new Date(now() + INVITATION_TTL_DAYS * 24 * 3600_000).toISOString();

  // TOUT se decide en base, sous le verrou de la ligne du workspace :
  // deja-membre, sieges disponibles, unicite, insertion. Compter ici puis
  // inserer laisserait deux invitations concurrentes pour deux adresses
  // differentes se partager le dernier siege — chacune lisant « il en reste
  // un » avant que l'autre n'ait ecrit.
  const { data, error } = await db.rpc("create_workspace_invitation", {
    p_workspace_id: input.workspaceId,
    p_email: email,
    p_role: input.role,
    p_token_hash: hash,
    p_invited_by: input.invitedBy,
    p_seat_quota: quota,
    p_expires_at: expiresAt,
  });

  if (error) {
    console.error(`[team:invite] ${error.code ?? "inconnu"}`);
    return { ok: false, code: "storage_failed" };
  }

  const resultat = (data ?? [])[0] as
    | { status: string; invitation_id: string | null; seats: number }
    | undefined;

  switch (resultat?.status) {
    case "created":
      break;
    case "already_member":
      return { ok: false, code: "already_member" };
    case "already_invited":
      return { ok: false, code: "already_invited" };
    case "seats_exhausted":
      return { ok: false, code: "seats_exhausted", seats: resultat.seats };
    case "invalid_role":
      return { ok: false, code: "invalid_role" };
    default:
      return { ok: false, code: "storage_failed" };
  }

  if (!resultat.invitation_id) {
    return { ok: false, code: "storage_failed" };
  }

  return {
    ok: true,
    invitationId: resultat.invitation_id,
    token,
    expiresAt,
    email,
    role: input.role,
  };
}

/**
 * Révoque une invitation encore vivante.
 *
 * Le filtre porte AUSSI sur le workspace : un identifiant d'invitation volé ne
 * permet pas d'agir sur le workspace d'autrui.
 */
export async function revokeInvitation(
  db: SupabaseClient,
  input: { workspaceId: string; invitationId: string },
): Promise<{ ok: true } | { ok: false; code: "not_found" | "already_settled" }> {
  const { data } = await db
    .from("workspace_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", input.invitationId)
    .eq("workspace_id", input.workspaceId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id");

  if (!data || data.length === 0) {
    return { ok: false, code: "already_settled" };
  }
  return { ok: true };
}

/**
 * Renvoie une invitation : l'ancienne est révoquée et une NOUVELLE est émise.
 *
 * On ne peut pas « renvoyer le même lien » — le jeton n'est pas conservé, par
 * construction. C'est une propriété, pas une limite : un lien renvoyé est un
 * lien neuf, et l'ancien cesse de fonctionner.
 */
export async function resendInvitation(
  deps: InviteDeps,
  input: { workspaceId: string; invitationId: string; invitedBy: string },
): Promise<InviteOutcome> {
  const { data: ancienne } = await deps.db
    .from("workspace_invitations")
    .select("id, email, role, accepted_at, revoked_at")
    .eq("id", input.invitationId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle<Pick<InvitationRow, "id" | "email" | "role" | "accepted_at" | "revoked_at">>();

  if (!ancienne || ancienne.accepted_at !== null) {
    return { ok: false, code: "storage_failed" };
  }

  // Révoquée d'abord : l'index partiel n'accepte qu'une invitation vivante par
  // adresse, et le nouveau lien doit pouvoir naître.
  await deps.db
    .from("workspace_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", ancienne.id)
    .is("accepted_at", null)
    .is("revoked_at", null);

  return createInvitation(deps, {
    workspaceId: input.workspaceId,
    email: ancienne.email,
    role: ancienne.role,
    invitedBy: input.invitedBy,
  });
}
