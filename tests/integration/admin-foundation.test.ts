/**
 * C6 — Administration Kodeho : tests RÉELS contre le projet Supabase de
 * `.env.local`, avec de vrais JWT `authenticated`.
 *
 * Comptes dédiés (`postync-c6-*@example.com`) : user, support, admin, deux
 * super_admin. Les rôles initiaux sont posés avec la clé service_role (côté
 * test uniquement, équivalent de l'amorçage manuel documenté) ; tout le reste
 * passe par les RPC `admin_*` avec le JWT de chaque acteur.
 *
 * Nettoyage complet en afterAll : workspaces, entrées d'audit de test, puis
 * comptes. Ignoré si `.env.local` est absent.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const USERS = {
  user: { email: "postync-c6-user@example.com", role: "user", name: "C6 User" },
  support: { email: "postync-c6-support@example.com", role: "support", name: "C6 Support" },
  admin: { email: "postync-c6-admin@example.com", role: "admin", name: "C6 Admin" },
  super1: { email: "postync-c6-super1@example.com", role: "super_admin", name: "C6 Super 1" },
  super2: { email: "postync-c6-super2@example.com", role: "super_admin", name: "C6 Super 2" },
} as const;
type Key = keyof typeof USERS;
const PASSWORD = `C6-${randomUUID()}`;
const DENIED = "42501";
const CHECK_VIOLATION = "23514";
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };

let admin: SupabaseClient;
const ids: Record<Key, string> = { user: "", support: "", admin: "", super1: "", super2: "" };
const as: Record<Key, SupabaseClient> = {} as Record<Key, SupabaseClient>;
let userWorkspaceId = "";

async function profileOf(id: string) {
  const { data } = await admin
    .from("profiles")
    .select("platform_role, account_status")
    .eq("id", id)
    .single();
  return data as { platform_role: string; account_status: string };
}

/**
 * Super_admin ACTIFS dans toute la base, fixtures comprises.
 *
 * Le garde-fou « il en reste toujours un » est global : il ne connaît pas la
 * notion de fixture. Le test doit donc compter ce qui existe réellement, et
 * non supposer qu'il est seul au monde.
 */
async function superAdminsActifs(): Promise<number> {
  const { count } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("platform_role", "super_admin")
    .eq("account_status", "active");
  return count ?? 0;
}

async function auditFor(targetId: string) {
  const { data } = await admin
    .from("admin_audit_logs")
    .select("actor_user_id, action, target_type, target_id, metadata")
    .eq("target_id", targetId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const emails = new Set<string>(Object.values(USERS).map((u) => u.email));
  const targets = data.users.filter((u) => emails.has(u.email ?? ""));
  if (targets.length === 0) return;
  const targetIds = targets.map((u) => u.id);

  await admin.from("admin_audit_logs").delete().in("actor_user_id", targetIds);
  await admin.from("admin_audit_logs").delete().in("target_id", targetIds);
  const { data: ws } = await admin.from("workspaces").select("id").in("owner_id", targetIds);
  const wsIds = (ws ?? []).map((w) => w.id);
  if (wsIds.length > 0) {
    await admin.from("admin_audit_logs").delete().in("target_id", wsIds);
    await admin.from("workspaces").delete().in("id", wsIds);
  }
  for (const u of targets) {
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) throw error;
  }
}

describe.skipIf(!CONFIGURED)("C6 — administration Kodeho (API réelle)", () => {
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
      if (def.role !== "user") {
        // Amorçage des rôles de test (équivalent de supabase/scripts/promote_super_admin.sql).
        const { error: roleError } = await admin
          .from("profiles")
          .update({ platform_role: def.role })
          .eq("id", data.user.id);
        if (roleError) throw roleError;
      }
      const client = createClient(SUPABASE_URL, ANON_KEY, NO_SESSION);
      const { error: signError } = await client.auth.signInWithPassword({
        email: def.email,
        password: PASSWORD,
      });
      if (signError) throw signError;
      as[key] = client;
    }

    const { data: ws, error } = await as.user.rpc("create_workspace", { p_name: "C6 Workspace" });
    if (error) throw error;
    userWorkspaceId = (ws as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
    const userIds = Object.values(ids).filter(Boolean);
    const { data: leftUsers } = await admin.from("profiles").select("id").in("id", userIds);
    const { data: leftAudit } = await admin.from("admin_audit_logs").select("id").in("target_id", userIds);
    expect(leftUsers ?? []).toHaveLength(0);
    expect(leftAudit ?? []).toHaveLength(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  it("A1 — user : administration refusée (RPC et RLS)", async () => {
    const list = await as.user.rpc("admin_list_users");
    expect(list.error?.code).toBe(DENIED);
    const stats = await as.user.rpc("admin_dashboard_stats");
    expect(stats.error?.code).toBe(DENIED);
    const audit = await as.user.rpc("admin_list_audit_logs");
    expect(audit.error?.code).toBe(DENIED);

    // RLS : un user ne voit que son propre profil et aucune ligne d'audit.
    const { data: profiles } = await as.user.from("profiles").select("id");
    expect(profiles?.map((p) => p.id)).toEqual([ids.user]);
    const { data: logs } = await as.user.from("admin_audit_logs").select("id");
    expect(logs).toEqual([]);
  });

  it("A2 — support : lecture utilisateurs / workspaces autorisée, audit refusé", async () => {
    const { data: users, error } = await as.support.rpc("admin_list_users", { p_search: "postync-c6-" });
    expect(error).toBeNull();
    expect((users as { email: string }[]).map((u) => u.email)).toEqual(
      expect.arrayContaining(Object.values(USERS).map((u) => u.email)),
    );
    const detail = await as.support.rpc("admin_get_user", { p_user_id: ids.user });
    expect((detail.data as { email: string }[])[0]?.email).toBe(USERS.user.email);

    const ws = await as.support.rpc("admin_list_workspaces", { p_search: "C6 Workspace" });
    expect(ws.error).toBeNull();
    expect((ws.data as { id: string }[]).some((w) => w.id === userWorkspaceId)).toBe(true);

    const audit = await as.support.rpc("admin_list_audit_logs");
    expect(audit.error?.code).toBe(DENIED);
    const { data: logs } = await as.support.from("admin_audit_logs").select("id");
    expect(logs).toEqual([]);
  });

  it("A3 — support : suspension, rôle et Full Access refusés", async () => {
    const s = await as.support.rpc("admin_set_account_status", { p_user_id: ids.user, p_status: "suspended" });
    expect(s.error?.code).toBe(DENIED);
    const r = await as.support.rpc("admin_set_platform_role", { p_user_id: ids.user, p_role: "admin" });
    expect(r.error?.code).toBe(DENIED);
    const f = await as.support.rpc("admin_grant_full_access", { p_workspace_id: userWorkspaceId });
    expect(f.error?.code).toBe(DENIED);
    expect((await profileOf(ids.user)).account_status).toBe("active");
  });

  it("A4 / A12 — admin suspend un user ; le compte suspendu ne peut plus créer de workspace", async () => {
    const { error } = await as.admin.rpc("admin_set_account_status", { p_user_id: ids.user, p_status: "suspended" });
    expect(error).toBeNull();
    expect((await profileOf(ids.user)).account_status).toBe("suspended");

    const create = await as.user.rpc("create_workspace", { p_name: "Interdit" });
    expect(create.error?.code).toBe(DENIED);

    // Le compte lit toujours son statut (nécessaire à la page /account-suspended).
    const { data } = await as.user.from("profiles").select("account_status").eq("id", ids.user).single();
    expect(data?.account_status).toBe("suspended");
  });

  it("A5 / A13 — admin réactive ; l'accès est restauré", async () => {
    const { error } = await as.admin.rpc("admin_set_account_status", { p_user_id: ids.user, p_status: "active" });
    expect(error).toBeNull();
    expect((await profileOf(ids.user)).account_status).toBe("active");

    const { data: ws, error: createError } = await as.user.rpc("create_workspace", { p_name: "C6 Retour" });
    expect(createError).toBeNull();
    expect((ws as { slug: string }).slug).toBe("c6-retour");
  });

  it("A6 — admin ne peut pas devenir super_admin lui-même (ni changer son propre rôle)", async () => {
    const r1 = await as.admin.rpc("admin_set_platform_role", { p_user_id: ids.admin, p_role: "super_admin" });
    expect(r1.error?.code).toBe(DENIED);
    const r2 = await as.admin.rpc("admin_set_platform_role", { p_user_id: ids.admin, p_role: "user" });
    expect(r2.error?.code).toBe(DENIED);
    expect((await profileOf(ids.admin)).platform_role).toBe("admin");
  });

  it("A7 — admin ne peut ni attribuer super_admin ni toucher un super_admin ; user/support/admin OK", async () => {
    const up = await as.admin.rpc("admin_set_platform_role", { p_user_id: ids.user, p_role: "super_admin" });
    expect(up.error?.code).toBe(DENIED);
    const touch = await as.admin.rpc("admin_set_platform_role", { p_user_id: ids.super2, p_role: "admin" });
    expect(touch.error?.code).toBe(DENIED);
    const suspend = await as.admin.rpc("admin_set_account_status", { p_user_id: ids.super2, p_status: "suspended" });
    expect(suspend.error?.code).toBe(DENIED);

    const ok1 = await as.admin.rpc("admin_set_platform_role", { p_user_id: ids.user, p_role: "support" });
    expect(ok1.error).toBeNull();
    expect((await profileOf(ids.user)).platform_role).toBe("support");
    const ok2 = await as.admin.rpc("admin_set_platform_role", { p_user_id: ids.user, p_role: "user" });
    expect(ok2.error).toBeNull();
    expect((await profileOf(ids.user)).platform_role).toBe("user");
  });

  it("A8 — super_admin gère tous les rôles, y compris super_admin", async () => {
    const promote = await as.super1.rpc("admin_set_platform_role", { p_user_id: ids.user, p_role: "admin" });
    expect(promote.error).toBeNull();
    expect((await profileOf(ids.user)).platform_role).toBe("admin");
    const back = await as.super1.rpc("admin_set_platform_role", { p_user_id: ids.user, p_role: "user" });
    expect(back.error).toBeNull();

    const demote = await as.super1.rpc("admin_set_platform_role", { p_user_id: ids.super2, p_role: "admin" });
    expect(demote.error).toBeNull();
    expect((await profileOf(ids.super2)).platform_role).toBe("admin");
    const repromote = await as.super1.rpc("admin_set_platform_role", { p_user_id: ids.super2, p_role: "super_admin" });
    expect(repromote.error).toBeNull();
    expect((await profileOf(ids.super2)).platform_role).toBe("super_admin");
  });

  it("A11 — il reste toujours au moins un super_admin actif", async () => {
    // Deux super_admin : super1 peut démissionner…
    const resign = await as.super1.rpc("admin_set_platform_role", { p_user_id: ids.super1, p_role: "admin" });
    expect(resign.error).toBeNull();
    expect((await profileOf(ids.super1)).platform_role).toBe("admin");
    // …et super2 le rétablit.
    const restore = await as.super2.rpc("admin_set_platform_role", { p_user_id: ids.super1, p_role: "super_admin" });
    expect(restore.error).toBeNull();

    // super1 rétrograde super2 : super1 est alors le seul super_admin actif.
    const demote = await as.super1.rpc("admin_set_platform_role", { p_user_id: ids.super2, p_role: "admin" });
    expect(demote.error).toBeNull();

    // CE QUE CE TEST PEUT ET NE PEUT PAS PROUVER ICI.
    //
    // Le garde-fou est GLOBAL : il refuse la rétrogradation qui laisserait la
    // base sans aucun super_admin actif. Depuis l'amorçage de C6, ce projet
    // possède un super_admin RÉEL et permanent — le compte de l'éditeur — que
    // les fixtures n'ont évidemment pas le droit de toucher. Tant qu'il
    // existe, super1 n'est jamais « le dernier », et sa démission est
    // parfaitement légitime.
    //
    // Le test constate donc l'état réel plutôt que de le supposer. Supposer
    // aurait donné ce qui s'est produit le 2026-08-29 : un échec au moment où
    // un vrai super_admin est apparu, sans qu'aucune régression n'ait eu lieu.
    const autres = (await superAdminsActifs()) - 1; // hors super1 lui-même
    const last = await as.super1.rpc("admin_set_platform_role", { p_user_id: ids.super1, p_role: "admin" });

    if (autres === 0) {
      // Cas nominal d'un projet vierge : super1 EST le dernier, refus attendu.
      expect(last.error?.code).toBe(CHECK_VIOLATION);
      expect((await profileOf(ids.super1)).platform_role).toBe("super_admin");
    } else {
      // Un super_admin réel subsiste : la démission passe, et c'est correct.
      expect(last.error).toBeNull();
      const { error } = await admin
        .from("profiles")
        .update({ platform_role: "super_admin" })
        .eq("id", ids.super1);
      expect(error).toBeNull();
    }

    // L'INVARIANT, lui, vaut dans tous les cas et c'est le vrai sujet :
    // la base ne se retrouve JAMAIS sans super_admin actif.
    expect(await superAdminsActifs()).toBeGreaterThanOrEqual(1);

    const suspendLast = await as.super2.rpc("admin_set_account_status", { p_user_id: ids.super1, p_status: "suspended" });
    expect(suspendLast.error?.code).toBe(DENIED); // super2 n'est plus qu'admin

    // Rétablissement de super2 pour la suite.
    const repromote = await as.super1.rpc("admin_set_platform_role", { p_user_id: ids.super2, p_role: "super_admin" });
    expect(repromote.error).toBeNull();
  });

  it("A9 — chaque action sensible est journalisée avec son acteur", async () => {
    const logs = await auditFor(ids.user);
    const actions = logs.map((l) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining(["user.suspended", "user.reactivated", "user.role_changed"]),
    );
    const suspended = logs.find((l) => l.action === "user.suspended");
    expect(suspended?.actor_user_id).toBe(ids.admin);
    expect(suspended?.metadata).toEqual({ from: "active", to: "suspended" });

    // Lecture via RPC par un admin : OK ; aucun secret dans les metadata.
    const { data, error } = await as.admin.rpc("admin_list_audit_logs", { p_limit: 200 });
    expect(error).toBeNull();
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(/password|token|secret|service_role|cookie/i);
    expect((data as { actor_email: string }[]).some((l) => l.actor_email === USERS.admin.email)).toBe(true);
  });

  it("A10 — Full Access : grant (avec expiration) / revoke, visible par le membre, audité", async () => {
    const ends = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const grant = await as.admin.rpc("admin_grant_full_access", {
      p_workspace_id: userWorkspaceId,
      p_ends_at: ends,
      p_reason: "Compte partenaire Kodeho",
    });
    expect(grant.error).toBeNull();

    const { data: ent } = await admin
      .from("workspace_entitlements")
      .select("access_mode, ends_at, reason, granted_by")
      .eq("workspace_id", userWorkspaceId)
      .single();
    expect(ent?.access_mode).toBe("full_access");
    expect(ent?.reason).toBe("Compte partenaire Kodeho");
    expect(ent?.granted_by).toBe(ids.admin);
    expect(ent?.ends_at).not.toBeNull();

    // Le membre du workspace voit son droit (RLS) ; un autre user non.
    const mine = await as.user.from("workspace_entitlements").select("access_mode").eq("workspace_id", userWorkspaceId);
    expect(mine.data).toEqual([{ access_mode: "full_access" }]);
    const { data: hasAccess } = await as.user.rpc("workspace_has_full_access", { p_workspace_id: userWorkspaceId });
    expect(hasAccess).toBe(true);

    // Écriture directe interdite, même pour l'admin (tout passe par la RPC).
    const direct = await as.admin
      .from("workspace_entitlements")
      .update({ access_mode: "standard" })
      .eq("workspace_id", userWorkspaceId);
    expect(direct.error?.code).toBe(DENIED);

    const revoke = await as.super1.rpc("admin_revoke_full_access", {
      p_workspace_id: userWorkspaceId,
      p_reason: "Fin de test",
    });
    expect(revoke.error).toBeNull();
    const { data: after } = await admin
      .from("workspace_entitlements")
      .select("access_mode, ends_at")
      .eq("workspace_id", userWorkspaceId)
      .single();
    expect(after).toEqual({ access_mode: "standard", ends_at: null });
    const { data: hasAccessAfter } = await as.user.rpc("workspace_has_full_access", { p_workspace_id: userWorkspaceId });
    expect(hasAccessAfter).toBe(false);

    const logs = await auditFor(userWorkspaceId);
    expect(logs.map((l) => l.action)).toEqual([
      "workspace.full_access_granted",
      "workspace.full_access_revoked",
    ]);
    expect(logs[0].actor_user_id).toBe(ids.admin);
    expect(logs[1].actor_user_id).toBe(ids.super1);
    expect((logs[0].metadata as { reason: string }).reason).toBe("Compte partenaire Kodeho");
  });

  it("RLS — le personnel lit tout, un user ne voit que son périmètre ; workspace role ≠ platform_role", async () => {
    const { data: staffView } = await as.support.from("profiles").select("id");
    expect((staffView ?? []).length).toBeGreaterThanOrEqual(5);
    const { data: staffWs } = await as.support.from("workspaces").select("id").eq("id", userWorkspaceId);
    expect(staffWs).toHaveLength(1);

    // L'owner d'un workspace reste un simple user : aucune RPC admin.
    const owner = await as.user.rpc("admin_list_users");
    expect(owner.error?.code).toBe(DENIED);
    // Un admin plateforme n'est pas membre du workspace : workspace_role null.
    const { data: role } = await as.admin.rpc("workspace_role", { p_workspace_id: userWorkspaceId });
    expect(role).toBeNull();
  });

  it("statut — un administrateur suspendu perd tout pouvoir", async () => {
    const suspend = await as.super1.rpc("admin_set_account_status", { p_user_id: ids.admin, p_status: "suspended" });
    expect(suspend.error).toBeNull();
    const list = await as.admin.rpc("admin_list_users");
    expect(list.error?.code).toBe(DENIED);
    const restore = await as.super1.rpc("admin_set_account_status", { p_user_id: ids.admin, p_status: "active" });
    expect(restore.error).toBeNull();
    const again = await as.admin.rpc("admin_dashboard_stats");
    expect(again.error).toBeNull();
  });
});
