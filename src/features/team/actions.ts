"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getSiteOrigin } from "@/lib/site-url";
import { findMembershipBySlug } from "@/features/workspaces/resolve";
import { listMemberships, requireUser } from "@/features/workspaces/queries";
import { getWorkspaceAccess } from "@/server/billing/queries";
import { createServiceClient } from "@/server/supabase/service-client";
import {
  createInvitation,
  resendInvitation,
  revokeInvitation,
  type InviteFailureCode,
} from "@/server/team/invitations";
import type { WorkspaceMembership } from "@/types/workspace";
import type { WorkspaceRole } from "@/types/workspace-role";

import type { TeamActionState } from "./state";

/**
 * Gestion de l'équipe (C14).
 *
 * L'AUTORISATION VIT ICI, comme dans tous les autres modules du produit —
 * session revalidée, workspace résolu par slug contre les memberships réelles
 * sous RLS, rôle vérifié. Aucune seconde logique d'autorisation n'est
 * introduite ailleurs.
 *
 * Ce qui vit en BASE, et seulement là, c'est ce qu'aucune vérification
 * applicative ne peut garantir face à des requêtes concurrentes : le quota de
 * sièges du forfait, décompté et consommé sous le verrou de la ligne du
 * workspace, et l'existence du propriétaire, protégée ligne par ligne depuis
 * C4. Vérifier puis écrire depuis l'application laisserait à chaque fois une
 * fenêtre entre les deux.
 *
 * HIÉRARCHIE DES RÔLES, reprise de celle qui existait déjà :
 *   * `owner`  gère tout le monde ;
 *   * `admin`  gère les `member`, et personne d'autre — il ne peut ni toucher
 *              le propriétaire, ni s'attribuer son rang ;
 *   * `member` ne gère personne.
 *
 * Cette asymétrie n'est pas décorative : sans elle, un admin pourrait évincer
 * celui qui l'a invité.
 *
 * UN SEUL PROPRIÉTAIRE PAR WORKSPACE. Ce n'est pas une règle introduite ici :
 * `protect_owner_membership`, posé en C4, l'impose ligne par ligne — la
 * propriété suit `workspaces.owner_id`, l'appartenance du propriétaire ne peut
 * être ni supprimée ni modifiée, et personne d'autre ne peut porter le rôle
 * `owner`. Le transfert de propriété est donc une opération à part entière,
 * hors du périmètre de la gestion d'équipe.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVITE_ERRORS: Record<InviteFailureCode, (seats: number) => string> = {
  invalid_email: () => "Cette adresse e-mail n'est pas valide.",
  invalid_role: () => "Rôle invalide.",
  already_member: () => "Cette personne fait déjà partie du workspace.",
  already_invited: () =>
    "Une invitation est déjà en attente pour cette adresse. Renvoyez-la ou annulez-la.",
  seats_exhausted: (seats) =>
    `Votre plan autorise ${seats} membre(s) par workspace, invitations en attente comprises. Passez à un plan supérieur pour agrandir l'équipe.`,
  storage_failed: () => "L'invitation n'a pas pu être créée. Réessayez.",
};

type Autorisation =
  | { ok: true; membership: WorkspaceMembership; actorId: string }
  | { ok: false; error: string };

/** Owner et admin gèrent l'équipe ; un member consulte seulement. */
async function requireTeamManager(formData: FormData): Promise<Autorisation> {
  const slug = String(formData.get("workspaceSlug") ?? "");
  const { supabase, user } = await requireUser();
  const memberships = await listMemberships(supabase, user.id);
  const membership = findMembershipBySlug(memberships, slug);
  if (!membership) {
    return { ok: false, error: "Workspace introuvable." };
  }
  if (membership.role !== "owner" && membership.role !== "admin") {
    return { ok: false, error: "Seul le propriétaire ou un admin peut gérer l'équipe." };
  }
  return { ok: true, membership, actorId: user.id };
}

/**
 * L'acteur peut-il agir sur ce membre ?
 *
 * Un admin ne touche pas à un propriétaire. Sans cette règle, l'admin pourrait
 * évincer celui qui l'a invité — et la hiérarchie ne voudrait plus rien dire.
 */
function peutAgirSur(acteur: WorkspaceRole, cible: WorkspaceRole): boolean {
  if (acteur === "owner") return true;
  if (acteur === "admin") return cible === "member";
  return false;
}

async function roleDuMembre(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const db = createServiceClient();
  const { data } = await db
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle<{ role: WorkspaceRole }>();
  return data?.role ?? null;
}

function rafraichir(slug: string): void {
  revalidatePath(`/app/${slug}/team`);
  revalidatePath(`/app/${slug}/settings`);
}

// ---------------------------------------------------------------------------
// Inviter
// ---------------------------------------------------------------------------

export async function inviteMemberAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const auth = await requireTeamManager(formData);
  if (!auth.ok) {
    return { error: auth.error, notice: null, invitationUrl: null, invitationId: null };
  }

  // Un admin ne peut inviter que des `member` : lui laisser créer des admins
  // reviendrait à lui donner le pouvoir d'en faire ses pairs sans l'accord du
  // propriétaire.
  const role = String(formData.get("role") ?? "member");
  if (auth.membership.role === "admin" && role !== "member") {
    return {
      error: "Un admin ne peut inviter que des membres.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }

  const { supabase } = await requireUser();
  const db = createServiceClient();
  const outcome = await createInvitation(
    {
      db,
      getSeatQuota: async (workspaceId) => {
        const { access } = await getWorkspaceAccess(supabase, workspaceId);
        return access.quotas.members;
      },
    },
    {
      workspaceId: auth.membership.workspace.id,
      email: String(formData.get("email") ?? ""),
      role,
      invitedBy: auth.actorId,
    },
  );

  rafraichir(auth.membership.workspace.slug);

  if (!outcome.ok) {
    return {
      error: INVITE_ERRORS[outcome.code](outcome.seats ?? 0),
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }

  const origin = await getSiteOrigin();
  return {
    error: null,
    notice:
      "Invitation créée. Transmettez ce lien à la personne concernée : lui seul permet de rejoindre le workspace, et il ne sera plus affiché ensuite.",
    invitationUrl: `${origin}/invitations/${outcome.token}`,
    invitationId: outcome.invitationId,
  };
}

// ---------------------------------------------------------------------------
// Renvoyer / annuler une invitation
// ---------------------------------------------------------------------------

export async function resendInvitationAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const auth = await requireTeamManager(formData);
  if (!auth.ok) {
    return { error: auth.error, notice: null, invitationUrl: null, invitationId: null };
  }
  const invitationId = String(formData.get("invitationId") ?? "");
  if (!UUID.test(invitationId)) {
    return { error: "Invitation invalide.", notice: null, invitationUrl: null, invitationId: null };
  }

  const { supabase } = await requireUser();
  const db = createServiceClient();
  const outcome = await resendInvitation(
    {
      db,
      getSeatQuota: async (workspaceId) => {
        const { access } = await getWorkspaceAccess(supabase, workspaceId);
        return access.quotas.members;
      },
    },
    {
      workspaceId: auth.membership.workspace.id,
      invitationId,
      invitedBy: auth.actorId,
    },
  );

  rafraichir(auth.membership.workspace.slug);

  if (!outcome.ok) {
    return {
      error: "Cette invitation ne peut plus être renvoyée.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }

  const origin = await getSiteOrigin();
  return {
    error: null,
    notice:
      "Nouveau lien émis. Le précédent ne fonctionne plus — le jeton n'étant pas conservé, renvoyer produit toujours un lien neuf.",
    invitationUrl: `${origin}/invitations/${outcome.token}`,
    invitationId: outcome.invitationId,
  };
}

export async function revokeInvitationAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const auth = await requireTeamManager(formData);
  if (!auth.ok) {
    return { error: auth.error, notice: null, invitationUrl: null, invitationId: null };
  }
  const invitationId = String(formData.get("invitationId") ?? "");
  if (!UUID.test(invitationId)) {
    return { error: "Invitation invalide.", notice: null, invitationUrl: null, invitationId: null };
  }

  const result = await revokeInvitation(createServiceClient(), {
    workspaceId: auth.membership.workspace.id,
    invitationId,
  });

  rafraichir(auth.membership.workspace.slug);

  if (!result.ok) {
    return {
      error: "Cette invitation a déjà été acceptée ou annulée.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }
  return { error: null, notice: "Invitation annulée.", invitationUrl: null, invitationId: null };
}

// ---------------------------------------------------------------------------
// Rôle et retrait
// ---------------------------------------------------------------------------

export async function setMemberRoleAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const auth = await requireTeamManager(formData);
  if (!auth.ok) {
    return { error: auth.error, notice: null, invitationUrl: null, invitationId: null };
  }
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!UUID.test(userId)) {
    return { error: "Membre invalide.", notice: null, invitationUrl: null, invitationId: null };
  }

  const actuel = await roleDuMembre(auth.membership.workspace.id, userId);
  if (!actuel) {
    return { error: "Ce membre n'appartient pas à ce workspace.", notice: null, invitationUrl: null, invitationId: null };
  }
  if (!peutAgirSur(auth.membership.role, actuel)) {
    return {
      error: "Vous ne pouvez pas modifier le rôle de cette personne.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }
  // Un workspace n'a qu'un propriétaire, et c'est `workspaces.owner_id`.
  // Transférer la propriété est une autre opération, pas un changement de rôle.
  if (role === "owner") {
    return {
      error:
        "Un workspace n'a qu'un seul propriétaire. Le transfert de propriété n'est pas proposé ici.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }

  const db = createServiceClient();
  const { data, error } = await db.rpc("set_workspace_member_role", {
    p_workspace_id: auth.membership.workspace.id,
    p_user_id: userId,
    p_role: role,
  });

  rafraichir(auth.membership.workspace.slug);

  if (error) {
    console.error(`[team:role] ${error.code ?? "inconnu"}`);
    return { error: "Le rôle n'a pas pu être modifié. Réessayez.", notice: null, invitationUrl: null, invitationId: null };
  }

  const statut = String(data);
  if (statut === "is_owner") {
    return {
      error:
        "Le propriétaire du workspace conserve son rôle : sans lui, plus personne ne pourrait l'administrer.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }
  if (statut === "owner_is_unique") {
    return {
      error: "Un workspace n'a qu'un seul propriétaire.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }
  if (statut !== "updated" && statut !== "unchanged") {
    return { error: "Le rôle n'a pas pu être modifié.", notice: null, invitationUrl: null, invitationId: null };
  }
  return { error: null, notice: "Rôle mis à jour.", invitationUrl: null, invitationId: null };
}

export async function removeMemberAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const auth = await requireTeamManager(formData);
  if (!auth.ok) {
    return { error: auth.error, notice: null, invitationUrl: null, invitationId: null };
  }
  const userId = String(formData.get("userId") ?? "");
  if (!UUID.test(userId)) {
    return { error: "Membre invalide.", notice: null, invitationUrl: null, invitationId: null };
  }

  const actuel = await roleDuMembre(auth.membership.workspace.id, userId);
  if (!actuel) {
    return { error: "Ce membre n'appartient pas à ce workspace.", notice: null, invitationUrl: null, invitationId: null };
  }
  if (!peutAgirSur(auth.membership.role, actuel)) {
    return {
      error: "Vous ne pouvez pas retirer cette personne.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }

  const db = createServiceClient();
  const { data, error } = await db.rpc("remove_workspace_member", {
    p_workspace_id: auth.membership.workspace.id,
    p_user_id: userId,
  });

  rafraichir(auth.membership.workspace.slug);

  if (error) {
    console.error(`[team:remove] ${error.code ?? "inconnu"}`);
    return { error: "Le membre n'a pas pu être retiré. Réessayez.", notice: null, invitationUrl: null, invitationId: null };
  }

  const statut = String(data);
  if (statut === "is_owner") {
    return {
      error:
        "Le propriétaire du workspace ne peut pas en être retiré : plus personne ne pourrait l'administrer.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }
  if (statut !== "removed") {
    return { error: "Le membre n'a pas pu être retiré.", notice: null, invitationUrl: null, invitationId: null };
  }
  return { error: null, notice: "Membre retiré du workspace.", invitationUrl: null, invitationId: null };
}

// ---------------------------------------------------------------------------
// Quitter un workspace
// ---------------------------------------------------------------------------

/**
 * Quitter un workspace dont on est membre.
 *
 * POURQUOI C'EST UNE ACTION À PART. Toutes les autres passent par
 * `requireTeamManager` : elles demandent un pouvoir sur QUELQU'UN D'AUTRE.
 * Celle-ci n'en demande aucun — on n'a pas besoin d'être admin pour cesser
 * d'appartenir à une équipe. Sans elle, un membre invité restait attaché à vie,
 * dépendant de la bonne volonté d'un owner pour en sortir : ce n'est pas une
 * lacune d'interface, c'est une personne qui ne peut pas partir.
 *
 * LE PROPRIÉTAIRE NE PEUT PAS PARTIR, et le message le dit sans détour :
 * `workspaces.owner_id` le désigne, le workspace resterait sans personne pour
 * l'administrer. La base le refuserait de toute façon — le contrôle est ici
 * pour donner une explication plutôt qu'un refus muet.
 */
export async function leaveWorkspaceAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const slug = String(formData.get("workspaceSlug") ?? "");
  const { supabase, user } = await requireUser();
  const memberships = await listMemberships(supabase, user.id);
  const membership = findMembershipBySlug(memberships, slug);

  if (!membership) {
    return { error: "Workspace introuvable.", notice: null, invitationUrl: null, invitationId: null };
  }

  if (membership.role === "owner") {
    return {
      error:
        "Vous êtes le propriétaire de ce workspace : le quitter le laisserait sans personne pour l'administrer.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }

  const db = createServiceClient();
  const { data, error } = await db.rpc("remove_workspace_member", {
    p_workspace_id: membership.workspace.id,
    p_user_id: user.id,
  });

  if (error) {
    console.error(`[team:leave] ${error.code ?? "inconnu"}`);
    return {
      error: "Vous n'avez pas pu quitter ce workspace. Réessayez.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }

  const statut = String(data);
  if (statut !== "removed") {
    return {
      error: "Vous n'avez pas pu quitter ce workspace.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }

  // La liste des workspaces du bandeau change : elle est lue à la racine.
  revalidatePath("/", "layout");
  // On ne renvoie pas vers `/app/<slug>` — il vient de devenir inaccessible.
  redirect("/app");
}
