/**
 * C8.1 — Server Actions des comptes sociaux : autorisations réelles (JWT
 * réels, RLS réelle), déconnexion avec purge Vault, isolation inter-workspaces.
 * Même montage que les tests checkout C7 (client serveur remplacé par le
 * client réel de l'acteur ; tout le reste est authentique).
 */
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const env = await vi.hoisted(async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const file = resolve(process.cwd(), ".env.local");
  const vars: Record<string, string> = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(new RegExp("\\r?\\n"))) {
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (vars[key]) process.env[key] = vars[key];
  }
  return vars;
});

let currentActor: SupabaseClient;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentActor,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { disconnectAction, startConnectAction } from "@/server/social/actions";
import { IDLE_SOCIAL_ACTION } from "@/server/social/action-state";
import { vaultRead, vaultStore } from "@/server/social/vault";

const CONFIGURED = Boolean(
  env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY,
);
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };
const PASSWORD = `C81a-${randomUUID()}`;
const USERS = {
  owner: "postync-c81a-owner@example.com",
  member: "postync-c81a-member@example.com",
  outsider: "postync-c81a-outsider@example.com",
} as const;
type Key = keyof typeof USERS;

let admin: SupabaseClient;
const ids: Record<Key, string> = { owner: "", member: "", outsider: "" };
const clients: Record<Key, SupabaseClient> = {} as Record<Key, SupabaseClient>;
let workspaceId = "";
let slug = "";
let otherSlug = "";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const emails = new Set<string>(Object.values(USERS));
  for (const u of data.users.filter((u) => emails.has(u.email ?? ""))) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C8.1 — actions connect/disconnect (autorisations réelles)", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();
    for (const key of Object.keys(USERS) as Key[]) {
      const { data, error } = await admin.auth.admin.createUser({
        email: USERS[key],
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: `C81a ${key}` },
      });
      if (error) throw error;
      ids[key] = data.user.id;
      const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, NO_SESSION);
      const { error: e2 } = await client.auth.signInWithPassword({ email: USERS[key], password: PASSWORD });
      if (e2) throw e2;
      clients[key] = client;
    }
    const { data: ws, error } = await clients.owner.rpc("create_workspace", { p_name: "C81a WS" });
    if (error) throw error;
    workspaceId = (ws as { id: string }).id;
    slug = (ws as { slug: string }).slug;
    await admin.from("workspace_members").insert({ workspace_id: workspaceId, user_id: ids.member, role: "member" });
    const { data: ws2, error: e3 } = await clients.outsider.rpc("create_workspace", { p_name: "C81a Autre" });
    if (e3) throw e3;
    otherSlug = (ws2 as { slug: string }).slug;
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  it("connect — member refusé ; tiers : workspace indiscernable", async () => {
    currentActor = clients.member;
    const denied = await startConnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, platform: "youtube" }));
    expect(denied.error).toBe("Seul le propriétaire ou un admin du workspace peut gérer les comptes sociaux.");

    currentActor = clients.outsider;
    const foreign = await startConnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, platform: "youtube" }));
    expect(foreign.error).toBe("Workspace introuvable.");
  });

  it("connect — owner : plateforme invalide refusée ; provider non implémenté = message dédié (C8.1)", async () => {
    currentActor = clients.owner;
    const bad = await startConnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, platform: "myspace" }));
    expect(bad.error).toBe("Plateforme invalide.");
    const soon = await startConnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, platform: "youtube" }));
    expect(soon.error).toBe("L'intégration YouTube arrive dans une prochaine étape.");
  });

  it("disconnect — owner : ligne supprimée ET secrets Vault purgés ; member refusé ; id étranger introuvable", async () => {
    const accessId = await vaultStore(admin, "disc-access", "c81a/access");
    const refreshId = await vaultStore(admin, "disc-refresh", "c81a/refresh");
    const { data: row, error } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "youtube",
        provider_account_id: "UCdisc001",
        display_name: "À déconnecter",
        access_token_id: accessId,
        refresh_token_id: refreshId,
        connected_by: ids.owner,
      })
      .select("id")
      .single();
    expect(error).toBeNull();

    // member : refusé.
    currentActor = clients.member;
    const denied = await disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, accountId: row!.id }));
    expect(denied.error).toContain("propriétaire ou un admin");

    // outsider avec SON workspace mais l'id d'un compte du workspace A : introuvable.
    currentActor = clients.outsider;
    const cross = await disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: otherSlug, accountId: row!.id }));
    expect(cross.error).toBe("Compte introuvable.");
    const { count: still } = await admin
      .from("social_accounts").select("*", { count: "exact", head: true }).eq("id", row!.id);
    expect(still).toBe(1);

    // owner : succès, purge Vault via trigger.
    currentActor = clients.owner;
    const ok = await disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, accountId: row!.id }));
    expect(ok.error).toBeNull();
    const { count } = await admin
      .from("social_accounts").select("*", { count: "exact", head: true }).eq("id", row!.id);
    expect(count).toBe(0);
    expect(await vaultRead(admin, accessId)).toBeNull();
    expect(await vaultRead(admin, refreshId)).toBeNull();
  });
});
