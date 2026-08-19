/**
 * C4 — Tests multi-tenant RÉELS contre le projet Supabase de `.env.local`.
 *
 * Chaque utilisateur de test obtient un vrai JWT `authenticated` (connexion
 * par mot de passe) et attaque l'API REST / RPC exactement comme le ferait
 * un navigateur. La clé service_role n'est utilisée QUE pour créer, inspecter
 * et nettoyer les données de test — jamais pour exercer les politiques.
 *
 * Le fichier est ignoré (skip) si `.env.local` ne fournit pas l'URL, la clé
 * anon et la clé service_role. Il crée des comptes dédiés
 * (`postync-c4-*@example.com`) et les supprime à la fin, ainsi que leurs
 * workspaces. Il ne touche à aucun autre utilisateur.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Environnement
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Données de test (dédiées, nettoyées en afterAll)
// ---------------------------------------------------------------------------
const TEST_USERS = {
  a: { email: "postync-c4-a@example.com", name: "C4 User A" },
  b: { email: "postync-c4-b@example.com", name: "C4 User B" },
  c: { email: "postync-c4-c@example.com", name: "C4 User C (admin)" },
  d: { email: "postync-c4-d@example.com", name: "C4 User D (member)" },
} as const;
type UserKey = keyof typeof TEST_USERS;
// Mot de passe jetable, différent à chaque exécution (comptes supprimés en fin de test).
const TEST_PASSWORD = `C4-${randomUUID()}`;
const PERMISSION_DENIED = "42501";

type WorkspaceRow = { id: string; name: string; slug: string; owner_id: string };

const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };

let admin: SupabaseClient;
const ids: Record<UserKey, string> = { a: "", b: "", c: "", d: "" };
const as: Record<UserKey, SupabaseClient> = {} as Record<UserKey, SupabaseClient>;

let wsA: WorkspaceRow;
let wsB: WorkspaceRow;

async function deleteTestUsersIfAny() {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const emails = new Set<string>(Object.values(TEST_USERS).map((u) => u.email));
  const targets = data.users.filter((u) => emails.has(u.email ?? ""));
  if (targets.length === 0) return;

  // `owner_id` est en `on delete restrict` : supprimer d'abord les workspaces.
  const { error: wsError } = await admin
    .from("workspaces")
    .delete()
    .in(
      "owner_id",
      targets.map((u) => u.id),
    );
  if (wsError) throw wsError;

  for (const u of targets) {
    const { error: delError } = await admin.auth.admin.deleteUser(u.id);
    if (delError) throw delError;
  }
}

async function signIn(key: UserKey): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, NO_SESSION);
  const { error } = await client.auth.signInWithPassword({
    email: TEST_USERS[key].email,
    password: TEST_PASSWORD,
  });
  if (error) throw error;
  return client;
}

async function rpcCreate(client: SupabaseClient, name: string): Promise<WorkspaceRow> {
  const { data, error } = await client.rpc("create_workspace", { p_name: name });
  if (error) throw error;
  return data as WorkspaceRow;
}

describe.skipIf(!CONFIGURED)("C4 — isolation multi-tenant (API réelle)", () => {
  beforeAll(async () => {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, NO_SESSION);
    await deleteTestUsersIfAny();

    for (const key of Object.keys(TEST_USERS) as UserKey[]) {
      const { data, error } = await admin.auth.admin.createUser({
        email: TEST_USERS[key].email,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: TEST_USERS[key].name },
      });
      if (error) throw error;
      ids[key] = data.user.id;
      as[key] = await signIn(key);
    }
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await deleteTestUsersIfAny();

    // Vérification : plus aucune trace des données de test.
    const userIds = Object.values(ids).filter(Boolean);
    const { data: leftoverWs } = await admin
      .from("workspaces")
      .select("id")
      .in("owner_id", userIds);
    const { data: leftoverMembers } = await admin
      .from("workspace_members")
      .select("id")
      .in("user_id", userIds);
    const { data: leftoverProfiles } = await admin
      .from("profiles")
      .select("id")
      .in("id", userIds);
    expect(leftoverWs ?? []).toHaveLength(0);
    expect(leftoverMembers ?? []).toHaveLength(0);
    expect(leftoverProfiles ?? []).toHaveLength(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Création atomique
  // -------------------------------------------------------------------------
  it("create_workspace : 1 workspace + 1 membership owner, owner = auth.uid()", async () => {
    wsA = await rpcCreate(as.a, "Workspace A");

    expect(wsA.slug).toBe("workspace-a");
    expect(wsA.owner_id).toBe(ids.a);

    const { data: members } = await admin
      .from("workspace_members")
      .select("user_id, role")
      .eq("workspace_id", wsA.id);
    expect(members).toEqual([{ user_id: ids.a, role: "owner" }]);
  });

  it("create_workspace : un nom vide ne crée rien", async () => {
    const { error } = await as.a.rpc("create_workspace", { p_name: "   " });
    expect(error).not.toBeNull();

    const { data } = await admin.from("workspaces").select("id").eq("owner_id", ids.a);
    expect(data).toHaveLength(1);
  });

  it("create_workspace : refusé sans session (anon)", async () => {
    const anon = createClient(SUPABASE_URL, ANON_KEY, NO_SESSION);
    const { error } = await anon.rpc("create_workspace", { p_name: "Intrus" });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  // -------------------------------------------------------------------------
  // Slug
  // -------------------------------------------------------------------------
  it("slug : Kodeho ×3 -> kodeho, kodeho-2, kodeho-3", async () => {
    const k1 = await rpcCreate(as.a, "Kodeho");
    const k2 = await rpcCreate(as.a, "Kodeho");
    const k3 = await rpcCreate(as.a, "Kodeho");
    expect([k1.slug, k2.slug, k3.slug]).toEqual(["kodeho", "kodeho-2", "kodeho-3"]);
  });

  it("slug : normalisation des accents et de la ponctuation", async () => {
    const ws = await rpcCreate(as.a, "  Mon Agence — Éphémère & Co !  ");
    expect(ws.slug).toBe("mon-agence-ephemere-co");
    expect(ws.name).toBe("Mon Agence — Éphémère & Co !");
  });

  // -------------------------------------------------------------------------
  // Plusieurs workspaces par utilisateur
  // -------------------------------------------------------------------------
  it("plusieurs workspaces : A voit ses 5 workspaces et 5 memberships", async () => {
    const { data: ws } = await as.a.from("workspaces").select("id");
    expect(ws).toHaveLength(5);

    const { data: members } = await as.a
      .from("workspace_members")
      .select("role, workspace:workspaces(id, name, slug)")
      .eq("user_id", ids.a);
    expect(members).toHaveLength(5);
    for (const m of members ?? []) {
      expect(m.role).toBe("owner");
      expect(m.workspace).not.toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // T1–T10
  // -------------------------------------------------------------------------
  it("T1 — A lit Workspace A", async () => {
    wsB = await rpcCreate(as.b, "Workspace B");

    const { data } = await as.a.from("workspaces").select("id, name").eq("id", wsA.id);
    expect(data).toEqual([{ id: wsA.id, name: "Workspace A" }]);
  });

  it("T2 — A ne lit pas Workspace B (ni par id, ni par slug)", async () => {
    const byId = await as.a.from("workspaces").select("id").eq("id", wsB.id);
    const bySlug = await as.a.from("workspaces").select("id").eq("slug", wsB.slug);
    expect(byId.data).toEqual([]);
    expect(bySlug.data).toEqual([]);
  });

  it("T3 — B ne lit pas Workspace A", async () => {
    const { data } = await as.b.from("workspaces").select("id").eq("id", wsA.id);
    expect(data).toEqual([]);
  });

  it("T4 — A ne modifie pas Workspace B", async () => {
    const { data, error } = await as.a
      .from("workspaces")
      .update({ name: "Piraté" })
      .eq("id", wsB.id)
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: check } = await admin
      .from("workspaces")
      .select("name")
      .eq("id", wsB.id)
      .single();
    expect(check?.name).toBe("Workspace B");
  });

  it("T5 — A ne peut pas s'ajouter dans Workspace B", async () => {
    const { error } = await as.a
      .from("workspace_members")
      .insert({ workspace_id: wsB.id, user_id: ids.a, role: "member" });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("T6 — A ne devient pas admin arbitrairement (PATCH role refusé)", async () => {
    const { error } = await as.a
      .from("workspace_members")
      .update({ role: "admin" })
      .eq("workspace_id", wsA.id)
      .eq("user_id", ids.a);
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("T7 — A ne devient pas owner arbitrairement (role et owner_id refusés)", async () => {
    const role = await as.a
      .from("workspace_members")
      .update({ role: "owner" })
      .eq("workspace_id", wsB.id);
    expect(role.error?.code).toBe(PERMISSION_DENIED);

    const owner = await as.a
      .from("workspaces")
      .update({ owner_id: ids.a })
      .eq("id", wsA.id);
    expect(owner.error?.code).toBe(PERMISSION_DENIED);
  });

  it("T8 — un owner lit ses memberships, pas celles des autres workspaces", async () => {
    const { data } = await as.a.from("workspace_members").select("workspace_id, user_id, role");
    expect(data).toHaveLength(5);
    for (const m of data ?? []) {
      expect(m.user_id).toBe(ids.a);
      expect(m.role).toBe("owner");
      expect(m.workspace_id).not.toBe(wsB.id);
    }
  });

  it("T9 — un member accède au workspace auquel il appartient", async () => {
    // Ajout côté serveur (service_role) : aucune RPC de gestion de membres en C4.
    const { error } = await admin.from("workspace_members").insert([
      { workspace_id: wsA.id, user_id: ids.c, role: "admin" },
      { workspace_id: wsA.id, user_id: ids.d, role: "member" },
    ]);
    expect(error).toBeNull();

    const { data } = await as.d.from("workspaces").select("id, slug").eq("id", wsA.id);
    expect(data).toEqual([{ id: wsA.id, slug: wsA.slug }]);

    const { data: role } = await as.d.rpc("workspace_role", { p_workspace_id: wsA.id });
    expect(role).toBe("member");
  });

  it("T10 — un non-membre n'accède pas au workspace", async () => {
    const { data } = await as.b.from("workspaces").select("id").eq("id", wsA.id);
    expect(data).toEqual([]);

    const { data: isMember } = await as.b.rpc("is_workspace_member", {
      p_workspace_id: wsA.id,
    });
    expect(isMember).toBe(false);

    const { data: role } = await as.b.rpc("workspace_role", { p_workspace_id: wsA.id });
    expect(role).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Rôles owner / admin / member
  // -------------------------------------------------------------------------
  it("rôles — admin renomme, member non, personne ne change de rôle", async () => {
    const byAdmin = await as.c
      .from("workspaces")
      .update({ name: "Workspace A (admin)" })
      .eq("id", wsA.id)
      .select("name");
    expect(byAdmin.data).toEqual([{ name: "Workspace A (admin)" }]);

    const byMember = await as.d
      .from("workspaces")
      .update({ name: "Workspace A (member)" })
      .eq("id", wsA.id)
      .select("name");
    expect(byMember.data).toEqual([]);

    const byOwner = await as.a
      .from("workspaces")
      .update({ name: "Workspace A" })
      .eq("id", wsA.id)
      .select("name");
    expect(byOwner.data).toEqual([{ name: "Workspace A" }]);

    const adminToOwner = await as.c
      .from("workspace_members")
      .update({ role: "owner" })
      .eq("workspace_id", wsA.id)
      .eq("user_id", ids.c);
    expect(adminToOwner.error?.code).toBe(PERMISSION_DENIED);

    const memberToAdmin = await as.d
      .from("workspace_members")
      .update({ role: "admin" })
      .eq("workspace_id", wsA.id)
      .eq("user_id", ids.d);
    expect(memberToAdmin.error?.code).toBe(PERMISSION_DENIED);

    // Le member voit les memberships de son workspace (owner, admin, member).
    const { data: seenByMember } = await as.d
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", wsA.id);
    expect((seenByMember ?? []).map((m) => m.role).sort()).toEqual([
      "admin",
      "member",
      "owner",
    ]);
  });

  it("cohérence owner — même service_role ne peut ni rétrograder ni retirer le owner", async () => {
    const demote = await admin
      .from("workspace_members")
      .update({ role: "member" })
      .eq("workspace_id", wsA.id)
      .eq("user_id", ids.a);
    expect(demote.error).not.toBeNull();

    const remove = await admin
      .from("workspace_members")
      .delete()
      .eq("workspace_id", wsA.id)
      .eq("user_id", ids.a);
    expect(remove.error).not.toBeNull();

    const secondOwner = await admin
      .from("workspace_members")
      .update({ role: "owner" })
      .eq("workspace_id", wsA.id)
      .eq("user_id", ids.c);
    expect(secondOwner.error).not.toBeNull();
  });

  it("invariant — chaque workspace possède exactement une membership owner = owner_id", async () => {
    const { data: workspaces } = await admin.from("workspaces").select("id, owner_id");
    const { data: owners } = await admin
      .from("workspace_members")
      .select("workspace_id, user_id")
      .eq("role", "owner");

    expect(workspaces?.length).toBeGreaterThan(0);
    for (const ws of workspaces ?? []) {
      const matching = (owners ?? []).filter((o) => o.workspace_id === ws.id);
      expect(matching).toEqual([{ workspace_id: ws.id, user_id: ws.owner_id }]);
    }
  });
});
