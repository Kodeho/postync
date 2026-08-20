/**
 * C8.1 — socle comptes sociaux : tests RÉELS contre Supabase (Vault, RLS,
 * state usage unique, callback générique avec provider factice).
 *
 * Vérifie notamment les exigences de sécurité C8 :
 *   - authenticated/anon ne peuvent NI appeler les wrappers Vault NI lire les
 *     tables de secrets ;
 *   - les colonnes access_token_id / refresh_token_id sont inaccessibles même
 *     pour un membre légitime ;
 *   - replay du callback -> échec ; state expiré -> échec ;
 *   - un utilisateur étranger ne peut pas terminer un flux visant un autre
 *     workspace ; un rôle rétrogradé non plus ;
 *   - reconnexion = mise à jour + rotation des secrets Vault ;
 *   - déconnexion + suppression en cascade purgent Vault (triggers).
 *
 * Données dédiées postync-c81-*, nettoyées en afterAll.
 */
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Env AVANT les imports applicatifs (src/lib/supabase/env.ts capture au chargement).
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

import { handleOAuthCallback } from "@/server/social/callback";
import { createOAuthState, consumeOAuthState } from "@/server/social/oauth-state";
import { hashState } from "@/server/social/pkce";
import type { SocialProvider, TokenSet } from "@/server/social/providers/types";
import { vaultDelete, vaultRead, vaultStore } from "@/server/social/vault";

const CONFIGURED = Boolean(
  env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY,
);
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };
const PASSWORD = `C81-${randomUUID()}`;
const DENIED = "42501";

const USERS = {
  owner: "postync-c81-owner@example.com",
  member: "postync-c81-member@example.com",
  outsider: "postync-c81-outsider@example.com",
} as const;
type Key = keyof typeof USERS;

let admin: SupabaseClient;
const ids: Record<Key, string> = { owner: "", member: "", outsider: "" };
const clients: Record<Key, SupabaseClient> = {} as Record<Key, SupabaseClient>;
let workspaceId = "";
let slug = "";

/** Provider factice : aucun réseau, tokens déterministes par exécution. */
function fakeProvider(tokens?: Partial<TokenSet>): SocialProvider {
  return {
    platform: "youtube",
    usesPkce: true,
    buildAuthUrl: ({ state }) => `https://fake.example/auth?state=${state}`,
    exchangeCode: async ({ codeVerifier }) => {
      // Le verifier doit avoir fait l'aller-retour Vault.
      if (!codeVerifier) throw new Error("verifier manquant");
      return {
        accessToken: `fake-access-${randomUUID()}`,
        refreshToken: `fake-refresh-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        refreshExpiresAt: null,
        scopes: ["fake.scope"],
        ...tokens,
      };
    },
    fetchIdentity: async () => ({
      providerAccountId: "UCfakechannel001",
      displayName: "Chaîne C8.1",
      avatarUrl: null,
    }),
  };
}

function params(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

const getQuota = async () => 100;

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const emails = new Set<string>(Object.values(USERS));
  for (const u of data.users.filter((u) => emails.has(u.email ?? ""))) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C8.1 — socle comptes sociaux (Supabase réel)", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    for (const key of Object.keys(USERS) as Key[]) {
      const { data, error } = await admin.auth.admin.createUser({
        email: USERS[key],
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: `C81 ${key}` },
      });
      if (error) throw error;
      ids[key] = data.user.id;
      const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, NO_SESSION);
      const { error: signError } = await client.auth.signInWithPassword({
        email: USERS[key],
        password: PASSWORD,
      });
      if (signError) throw signError;
      clients[key] = client;
    }

    const { data: ws, error } = await clients.owner.rpc("create_workspace", { p_name: "C81 Social WS" });
    if (error) throw error;
    workspaceId = (ws as { id: string }).id;
    slug = (ws as { slug: string }).slug;
    await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: ids.member, role: "member" });
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Vault
  // -------------------------------------------------------------------------
  it("Vault — authenticated et anon ne peuvent NI stocker, NI lire, NI supprimer", async () => {
    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, NO_SESSION);
    for (const client of [clients.owner, clients.member, anon]) {
      const store = await client.rpc("social_vault_store", { p_secret: "x", p_name: "hack" });
      expect(store.error?.code).toBe(DENIED);
      const read = await client.rpc("social_vault_read", { p_id: randomUUID() });
      expect(read.error?.code).toBe(DENIED);
      const del = await client.rpc("social_vault_delete", { p_id: randomUUID() });
      expect(del.error?.code).toBe(DENIED);
    }
  });

  it("Vault — service_role : cycle stocker / lire / supprimer, schéma vault non exposé en REST", async () => {
    const id = await vaultStore(admin, "c81-secret-value", "c81/test");
    expect(await vaultRead(admin, id)).toBe("c81-secret-value");
    await vaultDelete(admin, id);
    expect(await vaultRead(admin, id)).toBeNull();

    // Même service_role ne peut pas requêter le schéma vault via PostgREST.
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/decrypted_secrets?select=id&limit=1`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "accept-profile": "vault",
      },
    });
    expect(res.status).toBe(406);
  });

  // -------------------------------------------------------------------------
  // RLS social_accounts + oauth_states
  // -------------------------------------------------------------------------
  it("RLS — membre lit les colonnes sûres ; colonnes de tokens refusées ; tiers aveugle ; aucune écriture", async () => {
    const accessId = await vaultStore(admin, "rls-access-token", "c81/rls");
    const { error: insertError } = await admin.from("social_accounts").insert({
      workspace_id: workspaceId,
      platform: "tiktok",
      provider_account_id: "c81-rls-account",
      display_name: "Compte RLS",
      access_token_id: accessId,
      scopes: ["s1"],
      connected_by: ids.owner,
    });
    expect(insertError).toBeNull();

    // Membre : lecture des colonnes sûres OK.
    const { data: safe, error: safeError } = await clients.member
      .from("social_accounts")
      .select("id, platform, display_name, status")
      .eq("workspace_id", workspaceId);
    expect(safeError).toBeNull();
    expect(safe).toHaveLength(1);

    // Même un membre légitime ne peut pas SÉLECTIONNER les références Vault.
    const tokenCol = await clients.member
      .from("social_accounts")
      .select("access_token_id")
      .eq("workspace_id", workspaceId);
    expect(tokenCol.error?.code).toBe(DENIED);
    const star = await clients.owner.from("social_accounts").select("*").eq("workspace_id", workspaceId);
    expect(star.error?.code).toBe(DENIED); // `*` inclut les colonnes interdites

    // Tiers : aucune ligne.
    const { data: outsider } = await clients.outsider
      .from("social_accounts")
      .select("id")
      .eq("workspace_id", workspaceId);
    expect(outsider).toEqual([]);

    // Écritures directes interdites, même pour l'owner.
    const ins = await clients.owner.from("social_accounts").insert({
      workspace_id: workspaceId,
      platform: "facebook",
      provider_account_id: "forge",
      access_token_id: randomUUID(),
    });
    expect(ins.error?.code).toBe(DENIED);
    const upd = await clients.owner
      .from("social_accounts")
      .update({ display_name: "hack" })
      .eq("workspace_id", workspaceId);
    expect(upd.error?.code).toBe(DENIED);
    const del = await clients.owner.from("social_accounts").delete().eq("workspace_id", workspaceId);
    expect(del.error?.code).toBe(DENIED);

    // oauth_states : invisible pour authenticated.
    const states = await clients.owner.from("oauth_states").select("id");
    expect(states.error?.code).toBe(DENIED);

    // Nettoyage + preuve de la purge Vault par trigger.
    await admin.from("social_accounts").delete().eq("provider_account_id", "c81-rls-account");
    expect(await vaultRead(admin, accessId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // State : usage unique, TTL
  // -------------------------------------------------------------------------
  it("state — consommation unique avec aller-retour PKCE ; replay et expiré refusés", async () => {
    const created = await createOAuthState(admin, {
      workspaceId,
      userId: ids.owner,
      platform: "youtube",
      redirectSlug: slug,
      usePkce: true,
    });
    expect(created.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const consumed = await consumeOAuthState(admin, created.state);
    expect(consumed).toMatchObject({ workspaceId, userId: ids.owner, platform: "youtube" });
    expect(consumed?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    // Replay : le même state est refusé.
    expect(await consumeOAuthState(admin, created.state)).toBeNull();
    // State inconnu : refusé.
    expect(await consumeOAuthState(admin, "etat-forge-par-attaquant")).toBeNull();

    // State expiré : refusé.
    await admin.from("oauth_states").insert({
      state_hash: hashState("state-expire-c81"),
      workspace_id: workspaceId,
      user_id: ids.owner,
      platform: "youtube",
      redirect_slug: slug,
      created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      expires_at: new Date(Date.now() - 50 * 60_000).toISOString(),
    });
    expect(await consumeOAuthState(admin, "state-expire-c81")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Callback générique
  // -------------------------------------------------------------------------
  it("callback — parcours nominal : compte créé, tokens dans Vault, jamais en clair en table", async () => {
    const provider = fakeProvider();
    const { state } = await createOAuthState(admin, {
      workspaceId,
      userId: ids.owner,
      platform: "youtube",
      redirectSlug: slug,
      usePkce: true,
    });

    const result = await handleOAuthCallback(
      { provider, userClient: clients.owner, serviceClient: admin, redirectUri: "https://postync.test/cb", getQuota },
      params({ code: "fake-code", state }),
    );
    expect(result).toEqual({ slug, outcome: "connected" });

    const { data: row } = await admin
      .from("social_accounts")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("provider_account_id", "UCfakechannel001")
      .single();
    expect(row.status).toBe("active");
    expect(row.display_name).toBe("Chaîne C8.1");
    expect(row.connected_by).toBe(ids.owner);
    // Les colonnes contiennent des UUID Vault, pas des tokens.
    expect(row.access_token_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(row)).not.toContain("fake-access");
    expect(JSON.stringify(row)).not.toContain("fake-refresh");
    // Et Vault contient bien les valeurs.
    expect(await vaultRead(admin, row.access_token_id)).toMatch(/^fake-access-/);
    expect(await vaultRead(admin, row.refresh_token_id)).toMatch(/^fake-refresh-/);
  });

  it("callback — REPLAY du même state : échec, aucune écriture supplémentaire", async () => {
    const provider = fakeProvider();
    const { state } = await createOAuthState(admin, {
      workspaceId,
      userId: ids.owner,
      platform: "youtube",
      redirectSlug: slug,
      usePkce: true,
    });
    const first = await handleOAuthCallback(
      { provider, userClient: clients.owner, serviceClient: admin, redirectUri: "https://postync.test/cb", getQuota },
      params({ code: "c1", state }),
    );
    expect(first.outcome).toBe("connected");

    const replay = await handleOAuthCallback(
      { provider, userClient: clients.owner, serviceClient: admin, redirectUri: "https://postync.test/cb", getQuota },
      params({ code: "c1", state }),
    );
    expect(replay).toEqual({ slug: null, outcome: "invalid_state" });
  });

  it("callback — un utilisateur étranger ne peut pas finaliser le flux d'un autre workspace", async () => {
    const provider = fakeProvider();
    const { state } = await createOAuthState(admin, {
      workspaceId,
      userId: ids.owner,
      platform: "youtube",
      redirectSlug: slug,
      usePkce: true,
    });
    // L'outsider (workspace B / aucun) présente le state volé de l'owner.
    const hijack = await handleOAuthCallback(
      { provider, userClient: clients.outsider, serviceClient: admin, redirectUri: "https://postync.test/cb", getQuota },
      params({ code: "c1", state }),
    );
    expect(hijack.outcome).toBe("not_authorized");
    // Et le state est consommé : il ne peut plus servir à personne.
    const retry = await handleOAuthCallback(
      { provider, userClient: clients.owner, serviceClient: admin, redirectUri: "https://postync.test/cb", getQuota },
      params({ code: "c1", state }),
    );
    expect(retry.outcome).toBe("invalid_state");
  });

  it("callback — un member (rôle insuffisant au retour) est refusé", async () => {
    const provider = fakeProvider();
    // State créé au nom du member (comme si son rôle avait été rétrogradé
    // entre le départ et le retour) : le rôle est re-vérifié au callback.
    const { state } = await createOAuthState(admin, {
      workspaceId,
      userId: ids.member,
      platform: "youtube",
      redirectSlug: slug,
      usePkce: true,
    });
    const result = await handleOAuthCallback(
      { provider, userClient: clients.member, serviceClient: admin, redirectUri: "https://postync.test/cb", getQuota },
      params({ code: "c1", state }),
    );
    expect(result.outcome).toBe("not_authorized");
  });

  it("callback — refus provider (error=access_denied) : state consommé, rien d'écrit", async () => {
    const provider = fakeProvider();
    const { state } = await createOAuthState(admin, {
      workspaceId,
      userId: ids.owner,
      platform: "youtube",
      redirectSlug: slug,
      usePkce: true,
    });
    const result = await handleOAuthCallback(
      { provider, userClient: clients.owner, serviceClient: admin, redirectUri: "https://postync.test/cb", getQuota },
      params({ error: "access_denied", state }),
    );
    expect(result).toEqual({ slug, outcome: "provider_denied" });
    const replay = await handleOAuthCallback(
      { provider, userClient: clients.owner, serviceClient: admin, redirectUri: "https://postync.test/cb", getQuota },
      params({ code: "c1", state }),
    );
    expect(replay.outcome).toBe("invalid_state");
  });

  it("callback — quota atteint : nouveau compte refusé ; reconnexion toujours permise (rotation Vault)", async () => {
    const provider = fakeProvider();
    const quotaOne = async () => 1; // il existe déjà UCfakechannel001

    // Nouveau compte -> refusé.
    const other: SocialProvider = {
      ...provider,
      fetchIdentity: async () => ({ providerAccountId: "UCother002", displayName: "Autre", avatarUrl: null }),
    };
    const s1 = await createOAuthState(admin, {
      workspaceId, userId: ids.owner, platform: "youtube", redirectSlug: slug, usePkce: true,
    });
    const denied = await handleOAuthCallback(
      { provider: other, userClient: clients.owner, serviceClient: admin, redirectUri: "https://postync.test/cb", getQuota: quotaOne },
      params({ code: "c1", state: s1.state }),
    );
    expect(denied.outcome).toBe("quota_exceeded");

    // Reconnexion du MÊME compte -> mise à jour + rotation des secrets Vault.
    const { data: before } = await admin
      .from("social_accounts")
      .select("id, access_token_id, refresh_token_id")
      .eq("provider_account_id", "UCfakechannel001")
      .single();
    const s2 = await createOAuthState(admin, {
      workspaceId, userId: ids.owner, platform: "youtube", redirectSlug: slug, usePkce: true,
    });
    const reconnected = await handleOAuthCallback(
      { provider, userClient: clients.owner, serviceClient: admin, redirectUri: "https://postync.test/cb", getQuota: quotaOne },
      params({ code: "c2", state: s2.state }),
    );
    expect(reconnected.outcome).toBe("connected");

    const { data: after, count } = await admin
      .from("social_accounts")
      .select("id, access_token_id, refresh_token_id", { count: "exact" })
      .eq("provider_account_id", "UCfakechannel001");
    expect(count).toBe(1); // pas de doublon
    expect(after![0].id).toBe(before!.id); // même ligne
    expect(after![0].access_token_id).not.toBe(before!.access_token_id);
    // Les anciens secrets sont détruits, les nouveaux lisibles.
    expect(await vaultRead(admin, before!.access_token_id)).toBeNull();
    expect(await vaultRead(admin, after![0].access_token_id)).toMatch(/^fake-access-/);
  });

  it("cascade — supprimer le workspace purge comptes, states et secrets Vault", async () => {
    const { data: rows } = await admin
      .from("social_accounts")
      .select("access_token_id")
      .eq("workspace_id", workspaceId);
    const tokenIds = (rows ?? []).map((r) => r.access_token_id);
    expect(tokenIds.length).toBeGreaterThan(0);

    await admin.from("workspaces").delete().eq("id", workspaceId);

    const { count: accounts } = await admin
      .from("social_accounts")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    const { count: states } = await admin
      .from("oauth_states")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    expect(accounts).toBe(0);
    expect(states).toBe(0);
    for (const id of tokenIds) {
      expect(await vaultRead(admin, id)).toBeNull();
    }
  });
});
