/**
 * C14 — Membres et invitations : tests RÉELS contre le projet Supabase de
 * `.env.local`, avec de vrais JWT `authenticated`.
 *
 * CE QUE CES TESTS CHERCHENT À CASSER.
 *
 *   1. Le lien qui fuite. Un jeton d'invitation transmis à la mauvaise
 *      personne doit être sans valeur : l'invitation est liée à une adresse.
 *   2. Le jeton lisible. La table ne stocke qu'une empreinte, et la colonne
 *      qui la porte n'est accordée à aucune session.
 *   3. La frontière entre workspaces. Un identifiant d'invitation connu ne
 *      doit rien permettre depuis un autre workspace.
 *   4. Le workspace orphelin. Aucune combinaison d'appels, même simultanés,
 *      ne doit laisser un workspace sans personne pour l'administrer.
 *   5. Le siège en trop. Deux invitations concurrentes pour deux adresses
 *      différentes ne doivent pas se partager le dernier siège du forfait.
 *   6. Le double clic. Accepter deux fois la même invitation au même instant
 *      ne doit produire qu'une seule adhésion.
 *   7. Le compte que l'on ne peut plus supprimer. Avoir accepté une invitation
 *      ne doit jamais empêcher la suppression d'un compte.
 *
 * Les points 4 à 6 sont des courses : elles ne se voient pas en lisant le code
 * séquentiellement, et aucune vérification applicative ne peut les empêcher.
 * Elles sont donc jouées RÉELLEMENT, par requêtes simultanées.
 *
 * SUR LA PROPRIÉTÉ. `protect_owner_membership` (C4) impose qu'un workspace ait
 * EXACTEMENT un propriétaire, et que ce soit `workspaces.owner_id` : son
 * appartenance ne peut être ni supprimée ni modifiée, et personne d'autre ne
 * peut porter le rôle `owner`. Les tests ci-dessous vérifient donc que C14
 * respecte ce modèle et refuse proprement, plutôt que d'inventer un
 * multi-propriétaire qui n'existe pas.
 *
 * Nettoyage complet en afterAll. Ignoré si `.env.local` est absent.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createInvitation,
  hashInvitationToken,
  revokeInvitation,
  resendInvitation,
  type InviteOutcome,
} from "@/server/team/invitations";

function loadEnvLocal(): Record<string, string> {
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

const env = loadEnvLocal();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CONFIGURED = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);

const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };
const DENIED = "42501";
const PASSWORD = `C14-${randomUUID()}`;

/**
 * Comptes de test. `tardif` n'est PAS créé au départ : il incarne le cas
 * « la personne invitée n'a pas encore de compte » et sera inscrit en cours
 * de route, exactement comme un vrai invité.
 */
const USERS = {
  owner: { email: "postync-c14-owner@example.com", name: "C14 Owner" },
  owner2: { email: "postync-c14-owner2@example.com", name: "C14 Owner 2" },
  admin: { email: "postync-c14-admin@example.com", name: "C14 Admin" },
  membre: { email: "postync-c14-member@example.com", name: "C14 Member" },
  etranger: { email: "postync-c14-outsider@example.com", name: "C14 Outsider" },
} as const;
type Key = keyof typeof USERS;

const EMAIL_TARDIF = "postync-c14-late@example.com";
const EMAIL_JETABLE = "postync-c14-jetable@example.com";
const TOUS_LES_EMAILS = [
  ...Object.values(USERS).map((u) => u.email),
  EMAIL_TARDIF,
  EMAIL_JETABLE,
];

let admin: SupabaseClient;
const ids: Record<Key, string> = {
  owner: "",
  owner2: "",
  admin: "",
  membre: "",
  etranger: "",
};
const as: Record<Key, SupabaseClient> = {} as Record<Key, SupabaseClient>;

/** Workspace principal (owner) et workspace tiers (étranger), pour l'isolation. */
let W1 = "";
let W1_SLUG = "";
let W2 = "";

/** Fabrique les dépendances d'invitation avec un quota de sièges imposé. */
function deps(quota: number) {
  return { db: admin, getSeatQuota: async () => quota };
}

async function inviter(
  workspaceId: string,
  email: string,
  role: "admin" | "member",
  quota: number,
): Promise<InviteOutcome> {
  return createInvitation(deps(quota), {
    workspaceId,
    email,
    role,
    invitedBy: ids.owner,
  });
}

async function connecter(email: string): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, NO_SESSION);
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function accepter(client: SupabaseClient, token: string): Promise<string> {
  const { data, error } = await client.rpc("accept_workspace_invitation", {
    p_token_hash: hashInvitationToken(token),
  });
  if (error) throw error;
  return String((data ?? [])[0]?.status ?? "");
}

async function rolesDe(workspaceId: string): Promise<Record<string, string>> {
  const { data } = await admin
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId);
  return Object.fromEntries((data ?? []).map((r) => [r.user_id, r.role]));
}

/** Sièges réellement occupés : membres + invitations encore vivantes. */
async function siegesOccupes(workspaceId: string): Promise<number> {
  const [membres, invitations] = await Promise.all([
    admin
      .from("workspace_members")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
    admin
      .from("workspace_invitations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString()),
  ]);
  return (membres.count ?? 0) + (invitations.count ?? 0);
}

async function nbProprietaires(workspaceId: string): Promise<number> {
  const { count } = await admin
    .from("workspace_members")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("role", "owner");
  return count ?? 0;
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const cibles = data.users.filter((u) => TOUS_LES_EMAILS.includes(u.email ?? ""));
  if (cibles.length === 0) return;
  const cibleIds = cibles.map((u) => u.id);

  const { data: ws } = await admin.from("workspaces").select("id").in("owner_id", cibleIds);
  const wsIds = (ws ?? []).map((w) => w.id);
  if (wsIds.length > 0) {
    await admin.from("workspace_invitations").delete().in("workspace_id", wsIds);
    await admin.from("workspaces").delete().in("id", wsIds);
  }
  for (const u of cibles) {
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) throw error;
  }
}

describe.skipIf(!CONFIGURED)("C14 — membres et invitations (base réelle)", () => {
  beforeAll(async () => {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    for (const key of Object.keys(USERS) as Key[]) {
      const def = USERS[key];
      const { data, error } = await admin.auth.admin.createUser({
        email: def.email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: def.name },
      });
      if (error) throw error;
      ids[key] = data.user.id;
      as[key] = await connecter(def.email);
    }

    const w1 = await as.owner.rpc("create_workspace", { p_name: "C14 Principal" });
    if (w1.error) throw w1.error;
    W1 = (w1.data as { id: string }).id;
    W1_SLUG = (w1.data as { slug: string }).slug;

    const w2 = await as.etranger.rpc("create_workspace", { p_name: "C14 Tiers" });
    if (w2.error) throw w2.error;
    W2 = (w2.data as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
    const { data: restants } = await admin.from("profiles").select("id").in("id", Object.values(ids).filter(Boolean));
    expect(restants ?? []).toHaveLength(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // A — Le jeton
  // -------------------------------------------------------------------------

  it("A1 — la table ne stocke que l'empreinte, jamais le jeton", async () => {
    const outcome = await inviter(W1, USERS.membre.email, "member", 10);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { data } = await admin
      .from("workspace_invitations")
      .select("token_hash, email, role")
      .eq("id", outcome.invitationId)
      .single();

    expect(data!.token_hash).toBe(hashInvitationToken(outcome.token));
    // Le jeton lui-même n'apparaît nulle part.
    expect(JSON.stringify(data)).not.toContain(outcome.token);
    expect(data!.email).toBe(USERS.membre.email);

    await admin.from("workspace_invitations").delete().eq("id", outcome.invitationId);
  });

  it("A2 — `token_hash` n'est lisible par aucune session authentifiée", async () => {
    const outcome = await inviter(W1, USERS.membre.email, "member", 10);
    if (!outcome.ok) throw new Error("invitation non créée");

    // Le propriétaire du workspace voit bien l'invitation…
    const visible = await as.owner
      .from("workspace_invitations")
      .select("id, email, role")
      .eq("id", outcome.invitationId);
    expect(visible.error).toBeNull();
    expect(visible.data).toHaveLength(1);

    // …mais pas la colonne qui porte l'empreinte.
    const interdit = await as.owner
      .from("workspace_invitations")
      .select("token_hash")
      .eq("id", outcome.invitationId);
    expect(interdit.error).not.toBeNull();

    await admin.from("workspace_invitations").delete().eq("id", outcome.invitationId);
  });

  it("A3 — sans session, l'acceptation est refusée par le GRANT", async () => {
    const anon = createClient(SUPABASE_URL, ANON_KEY, NO_SESSION);
    const { error } = await anon.rpc("accept_workspace_invitation", {
      p_token_hash: hashInvitationToken("peu-importe"),
    });
    expect(error?.code).toBe(DENIED);
  });

  it("A4 — un jeton inconnu ne dit rien de plus que « introuvable »", async () => {
    expect(await accepter(as.membre, randomUUID())).toBe("not_found");
  });

  // -------------------------------------------------------------------------
  // B — L'invitation est liée à une adresse
  // -------------------------------------------------------------------------

  it("B1 — un lien intercepté par une autre adresse ne donne aucun accès", async () => {
    const outcome = await inviter(W1, USERS.membre.email, "member", 10);
    if (!outcome.ok) throw new Error("invitation non créée");

    // L'étranger possède le lien : il ne lui sert à rien.
    expect(await accepter(as.etranger, outcome.token)).toBe("email_mismatch");
    expect(await rolesDe(W1)).not.toHaveProperty(ids.etranger);

    // …et l'invitation reste utilisable par son destinataire.
    const { data } = await admin
      .from("workspace_invitations")
      .select("accepted_at")
      .eq("id", outcome.invitationId)
      .single();
    expect(data!.accepted_at).toBeNull();

    await admin.from("workspace_invitations").delete().eq("id", outcome.invitationId);
  });

  it("B2 — le destinataire rejoint le bon workspace avec le bon rôle", async () => {
    const outcome = await inviter(W1, USERS.membre.email, "member", 10);
    if (!outcome.ok) throw new Error("invitation non créée");

    const { data, error } = await as.membre.rpc("accept_workspace_invitation", {
      p_token_hash: hashInvitationToken(outcome.token),
    });
    expect(error).toBeNull();
    expect((data ?? [])[0]).toMatchObject({ status: "accepted", slug: W1_SLUG });

    expect((await rolesDe(W1))[ids.membre]).toBe("member");
    // …et strictement rien dans le workspace tiers.
    expect(await rolesDe(W2)).not.toHaveProperty(ids.membre);
  });

  it("B3 — le rejeu du même lien ne crée pas de seconde adhésion", async () => {
    const outcome = await inviter(W1, USERS.admin.email, "admin", 10);
    if (!outcome.ok) throw new Error("invitation non créée");

    expect(await accepter(as.admin, outcome.token)).toBe("accepted");
    expect(await accepter(as.admin, outcome.token)).toBe("already_accepted");

    const { count } = await admin
      .from("workspace_members")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", W1)
      .eq("user_id", ids.admin);
    expect(count).toBe(1);
    expect((await rolesDe(W1))[ids.admin]).toBe("admin");
  });

  it("B4 — une invitation annulée puis expirée ne s'accepte plus", async () => {
    // Annulée.
    const annulee = await inviter(W1, "postync-c14-revoked@example.com", "member", 50);
    if (!annulee.ok) throw new Error("invitation non créée");
    expect(await revokeInvitation(admin, { workspaceId: W1, invitationId: annulee.invitationId })).toEqual({ ok: true });
    expect(await accepter(as.owner, annulee.token)).toBe("revoked");

    // Expirée. `workspace_invitations_ttl` impose `expires_at > created_at` :
    // les deux dates reculent ensemble, sinon l'écriture serait refusée et le
    // test passerait en croyant avoir expiré quelque chose.
    const expiree = await inviter(W1, "postync-c14-expired@example.com", "member", 50);
    if (!expiree.ok) throw new Error("invitation non créée");
    const passe = Date.now() - 30 * 24 * 3600_000;
    const { error } = await admin
      .from("workspace_invitations")
      .update({
        created_at: new Date(passe).toISOString(),
        expires_at: new Date(passe + 60_000).toISOString(),
      })
      .eq("id", expiree.invitationId);
    expect(error).toBeNull();
    expect(await accepter(as.owner, expiree.token)).toBe("expired");

    await admin.from("workspace_invitations").delete().eq("id", expiree.invitationId);
    await admin.from("workspace_invitations").delete().eq("id", annulee.invitationId);
  });

  it("B5 — une adresse sans compte peut s'inscrire APRÈS, puis rejoindre", async () => {
    const outcome = await inviter(W1, EMAIL_TARDIF, "member", 10);
    if (!outcome.ok) throw new Error("invitation non créée");

    // Le compte n'existe pas encore au moment de l'invitation.
    const avant = await admin.auth.admin.listUsers({ perPage: 1000 });
    expect(avant.data.users.some((u) => u.email === EMAIL_TARDIF)).toBe(false);

    const { data: cree, error } = await admin.auth.admin.createUser({
      email: EMAIL_TARDIF,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "C14 Tardif" },
    });
    if (error) throw error;

    const client = await connecter(EMAIL_TARDIF);
    expect(await accepter(client, outcome.token)).toBe("accepted");
    expect((await rolesDe(W1))[cree.user.id]).toBe("member");
  }, 30_000);

  // -------------------------------------------------------------------------
  // C — Isolation entre workspaces
  // -------------------------------------------------------------------------

  it("C1 — les invitations d'un workspace sont invisibles depuis un autre", async () => {
    const outcome = await inviter(W1, "postync-c14-secret@example.com", "member", 10);
    if (!outcome.ok) throw new Error("invitation non créée");

    // L'étranger est propriétaire de W2, membre d'aucun autre workspace.
    const vue = await as.etranger.from("workspace_invitations").select("id, email").eq("workspace_id", W1);
    expect(vue.error).toBeNull();
    expect(vue.data ?? []).toHaveLength(0);

    // Et il ne voit pas non plus la liste des membres de W1.
    const membres = await as.etranger.rpc("workspace_members_detailed", { p_workspace_id: W1 });
    expect(membres.data ?? []).toHaveLength(0);

    await admin.from("workspace_invitations").delete().eq("id", outcome.invitationId);
  });

  it("C2 — révoquer depuis un autre workspace ne fait rien", async () => {
    const outcome = await inviter(W1, "postync-c14-cross@example.com", "member", 10);
    if (!outcome.ok) throw new Error("invitation non créée");

    // Identifiant correct, mais présenté au nom du workspace tiers.
    const resultat = await revokeInvitation(admin, {
      workspaceId: W2,
      invitationId: outcome.invitationId,
    });
    expect(resultat.ok).toBe(false);

    const { data } = await admin
      .from("workspace_invitations")
      .select("revoked_at")
      .eq("id", outcome.invitationId)
      .single();
    expect(data!.revoked_at).toBeNull();

    await admin.from("workspace_invitations").delete().eq("id", outcome.invitationId);
  });

  // -------------------------------------------------------------------------
  // D — Quotas de sièges
  // -------------------------------------------------------------------------

  it("D1 — les invitations en attente comptent comme des sièges occupés", async () => {
    const quota = (await siegesOccupes(W1)) + 1; // un seul siège libre

    // La première invitation passe…
    const premiere = await inviter(W1, "postync-c14-q1@example.com", "member", quota);
    expect(premiere.ok).toBe(true);

    // …la seconde est refusée, alors qu'aucun MEMBRE n'a été ajouté entre
    // les deux : c'est bien l'invitation en attente qui occupe le siège.
    const seconde = await inviter(W1, "postync-c14-q2@example.com", "member", quota);
    expect(seconde).toMatchObject({ ok: false, code: "seats_exhausted", seats: quota });

    if (premiere.ok) {
      await admin.from("workspace_invitations").delete().eq("id", premiere.invitationId);
    }
  });

  it("D2 — deux invitations pour la même adresse : une seule vit à la fois", async () => {
    const a = await inviter(W1, "postync-c14-dup@example.com", "member", 50);
    expect(a.ok).toBe(true);
    const b = await inviter(W1, "postync-c14-dup@example.com", "member", 50);
    expect(b).toMatchObject({ ok: false, code: "already_invited" });

    // La casse de l'adresse ne contourne pas la règle.
    const c = await inviter(W1, "POSTYNC-C14-Dup@Example.com", "member", 50);
    expect(c).toMatchObject({ ok: false, code: "already_invited" });

    if (a.ok) await admin.from("workspace_invitations").delete().eq("id", a.invitationId);
  });

  it("D3 — inviter quelqu'un qui est déjà membre est refusé", async () => {
    const outcome = await inviter(W1, USERS.membre.email.toUpperCase(), "member", 50);
    expect(outcome).toMatchObject({ ok: false, code: "already_member" });
  });

  it("D4 — renvoyer émet un lien neuf et invalide l'ancien", async () => {
    const initiale = await inviter(W1, "postync-c14-resend@example.com", "member", 50);
    if (!initiale.ok) throw new Error("invitation non créée");

    const renvoyee = await resendInvitation(deps(50), {
      workspaceId: W1,
      invitationId: initiale.invitationId,
      invitedBy: ids.owner,
    });
    expect(renvoyee.ok).toBe(true);
    if (!renvoyee.ok) return;
    expect(renvoyee.token).not.toBe(initiale.token);

    // L'ancien lien ne désigne plus une invitation vivante.
    const { data: ancienne } = await admin
      .from("workspace_invitations")
      .select("revoked_at")
      .eq("id", initiale.invitationId)
      .single();
    expect(ancienne!.revoked_at).not.toBeNull();

    await admin.from("workspace_invitations").delete().eq("id", renvoyee.invitationId);
    await admin.from("workspace_invitations").delete().eq("id", initiale.invitationId);
  });

  // -------------------------------------------------------------------------
  // E — Concurrence : le dernier siège
  // -------------------------------------------------------------------------

  it("E1 — deux invitations SIMULTANÉES ne se partagent pas le dernier siège", async () => {
    const avant = await siegesOccupes(W1);
    const quota = avant + 1; // exactement un siège libre

    const [a, b] = await Promise.all([
      inviter(W1, "postync-c14-race-a@example.com", "member", quota),
      inviter(W1, "postync-c14-race-b@example.com", "member", quota),
    ]);

    const reussies = [a, b].filter((r) => r.ok);
    expect(reussies).toHaveLength(1);
    expect([a, b].filter((r) => !r.ok && r.code === "seats_exhausted")).toHaveLength(1);

    // Et la base le confirme : le quota n'a pas été dépassé d'un siège.
    expect(await siegesOccupes(W1)).toBe(quota);

    for (const r of reussies) {
      if (r.ok) await admin.from("workspace_invitations").delete().eq("id", r.invitationId);
    }
  }, 30_000);

  it("E2 — deux invitations SIMULTANÉES pour la même adresse : une seule écrite", async () => {
    const [a, b] = await Promise.all([
      inviter(W1, "postync-c14-race-same@example.com", "member", 50),
      inviter(W1, "postync-c14-race-same@example.com", "member", 50),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);

    const { count } = await admin
      .from("workspace_invitations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", W1)
      .eq("email", "postync-c14-race-same@example.com")
      .is("accepted_at", null)
      .is("revoked_at", null);
    expect(count).toBe(1);

    for (const r of [a, b]) {
      if (r.ok) await admin.from("workspace_invitations").delete().eq("id", r.invitationId);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // F — Concurrence : jamais de workspace sans propriétaire
  // -------------------------------------------------------------------------

  it("F1 — le propriétaire ne peut être ni retiré ni rétrogradé", async () => {
    const retrait = await admin.rpc("remove_workspace_member", {
      p_workspace_id: W1,
      p_user_id: ids.owner,
    });
    expect(retrait.error).toBeNull();
    expect(retrait.data).toBe("is_owner");

    const retrogradation = await admin.rpc("set_workspace_member_role", {
      p_workspace_id: W1,
      p_user_id: ids.owner,
      p_role: "member",
    });
    expect(retrogradation.error).toBeNull();
    expect(retrogradation.data).toBe("is_owner");

    expect((await rolesDe(W1))[ids.owner]).toBe("owner");
    expect(await nbProprietaires(W1)).toBe(1);
  });

  it("F2 — nommer un second propriétaire est refusé, sans exception brute", async () => {
    // Le déclencheur de C4 lèverait une erreur SQL ; la fonction doit rendre
    // un verdict, faute de quoi l'écran afficherait « Réessayez » pour une
    // opération qui ne réussira jamais.
    const promotion = await admin.rpc("set_workspace_member_role", {
      p_workspace_id: W1,
      p_user_id: ids.admin,
      p_role: "owner",
    });
    expect(promotion.error).toBeNull();
    expect(promotion.data).toBe("owner_is_unique");

    expect(await nbProprietaires(W1)).toBe(1);
    expect((await rolesDe(W1))[ids.admin]).toBe("admin");
  });

  it("F3 — écriture directe : le rôle `owner` est refusé au niveau de la ligne", async () => {
    // Même en service_role, en contournant entièrement les fonctions C14.
    const promotion = await admin
      .from("workspace_members")
      .update({ role: "owner" })
      .eq("workspace_id", W1)
      .eq("user_id", ids.admin);
    expect(promotion.error?.code).toBe("23514");

    const suppression = await admin
      .from("workspace_members")
      .delete()
      .eq("workspace_id", W1)
      .eq("user_id", ids.owner);
    expect(suppression.error?.code).toBe("23514");

    expect(await nbProprietaires(W1)).toBe(1);
  });

  it("F4 — retraits et rétrogradations SIMULTANÉS laissent le workspace administrable", async () => {
    const avant = await rolesDe(W1);
    expect(Object.keys(avant).length).toBeGreaterThan(1);

    // Tout le monde est visé en même temps, propriétaire compris, par les deux
    // opérations à la fois.
    const verdicts = await Promise.all([
      ...Object.keys(avant).map((id) =>
        admin.rpc("remove_workspace_member", { p_workspace_id: W1, p_user_id: id }),
      ),
      ...Object.keys(avant).map((id) =>
        admin.rpc("set_workspace_member_role", {
          p_workspace_id: W1,
          p_user_id: id,
          p_role: "member",
        }),
      ),
    ]);

    // Aucune erreur brute : chaque appel a rendu un verdict.
    for (const v of verdicts) {
      expect(v.error).toBeNull();
    }
    // L'INVARIANT : le propriétaire est toujours là, avec son rôle.
    expect((await rolesDe(W1))[ids.owner]).toBe("owner");
    expect(await nbProprietaires(W1)).toBe(1);
  }, 60_000);

  it("F5 — un membre d'un autre workspace ne peut pas être retiré d'ici", async () => {
    const resultat = await admin.rpc("remove_workspace_member", {
      p_workspace_id: W1,
      p_user_id: ids.etranger,
    });
    expect(resultat.data).toBe("member_not_found");

    // Et l'étranger reste propriétaire de son propre workspace.
    expect((await rolesDe(W2))[ids.etranger]).toBe("owner");
  });

  // -------------------------------------------------------------------------
  // G — Concurrence : acceptation, et lecture des membres
  // -------------------------------------------------------------------------

  it("G1 — accepter DEUX FOIS au même instant ne crée qu'une adhésion", async () => {
    const outcome = await inviter(W1, USERS.owner2.email, "member", 50);
    if (!outcome.ok) throw new Error("invitation non créée");

    const hash = hashInvitationToken(outcome.token);
    const [a, b] = await Promise.all([
      as.owner2.rpc("accept_workspace_invitation", { p_token_hash: hash }),
      as.owner2.rpc("accept_workspace_invitation", { p_token_hash: hash }),
    ]);

    const statuts = [a, b].map((r) => String((r.data ?? [])[0]?.status ?? r.error?.code));
    // Le verrou sur la ligne d'invitation sérialise les deux appels : l'un
    // accepte, l'autre constate que c'est déjà fait.
    expect(statuts.filter((v) => v === "accepted")).toHaveLength(1);
    expect(statuts.filter((v) => v === "already_accepted")).toHaveLength(1);

    const { count } = await admin
      .from("workspace_members")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", W1)
      .eq("user_id", ids.owner2);
    expect(count).toBe(1);
  }, 40_000);

  it("G3 — un compte ayant accepté une invitation reste supprimable", async () => {
    // ANOMALIE DÉMONTRÉE le 2026-08-28 : `accepted_by` est
    // `on delete set null`, mais la contrainte posée avec la table exigeait
    // `accepted_by` non nul dès lors qu'`accepted_at` l'était. La mise à null
    // entrait donc en collision avec elle, et Supabase refusait la suppression
    // avec « Database error deleting user ».
    //
    // Toute personne ayant un jour rejoint un workspace par invitation
    // devenait ainsi INSUPPRIMABLE, y compris pour un administrateur.
    const { data: cree, error: creation } = await admin.auth.admin.createUser({
      email: "postync-c14-jetable@example.com",
      password: PASSWORD,
      email_confirm: true,
    });
    if (creation) throw creation;

    const outcome = await inviter(W1, "postync-c14-jetable@example.com", "member", 50);
    if (!outcome.ok) throw new Error("invitation non créée");

    const client = await connecter("postync-c14-jetable@example.com");
    expect(await accepter(client, outcome.token)).toBe("accepted");

    // La suppression doit aboutir…
    const { error } = await admin.auth.admin.deleteUser(cree.user.id);
    expect(error).toBeNull();

    // …et l'acceptation rester vraie, simplement sans auteur.
    const { data: trace } = await admin
      .from("workspace_invitations")
      .select("accepted_at, accepted_by")
      .eq("id", outcome.invitationId)
      .single();
    expect(trace!.accepted_at).not.toBeNull();
    expect(trace!.accepted_by).toBeNull();

    await admin.from("workspace_invitations").delete().eq("id", outcome.invitationId);
  }, 40_000);

  it("G2 — la liste des membres s'arrête à la frontière du workspace", async () => {
    const vue = await as.owner2.rpc("workspace_members_detailed", { p_workspace_id: W2 });
    expect(vue.error).toBeNull();
    expect(vue.data ?? []).toHaveLength(0);

    // …alors que le sien lui est bien visible.
    const sien = await as.owner2.rpc("workspace_members_detailed", { p_workspace_id: W1 });
    expect((sien.data ?? []).length).toBeGreaterThan(0);
  });
});
