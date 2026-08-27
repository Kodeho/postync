/**
 * C8.5 — rafraîchissement des jetons contre la VRAIE base et le VRAI Vault.
 *
 * Le provider est simulé (aucun appel distant), mais la rotation des secrets,
 * l'écriture de la ligne et le basculement de statut sont authentiques.
 *
 * Ce qu'on éprouve : un compte dont l'access token a expiré mais qui possède
 * un refresh token doit rester exploitable, et un refus de la plateforme doit
 * se voir dans l'interface plutôt que d'échouer en silence.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { effectiveStatus } from "@/server/social/accounts";
import type { SocialProvider, TokenSet } from "@/server/social/providers/types";
import { getUsableAccessToken, REFRESH_MARGIN_MS } from "@/server/social/token";
import { vaultRead, vaultStore } from "@/server/social/vault";

function loadEnvLocal(): Record<string, string> {
  const vars: Record<string, string> = {};
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return vars;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    vars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return vars;
}

const env = loadEnvLocal();
const CONFIGURED = Boolean(
  env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY,
);
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };
const PASSWORD = `C85-${randomUUID()}`;
const EMAIL = "postync-c85-owner@example.com";

let admin: SupabaseClient;
let ownerClient: SupabaseClient;
let ownerId = "";
let workspaceId = "";

const HOUR = 3_600_000;

/** Provider simulé : renvoie le jeu de jetons programmé, ou échoue. */
function fakeProvider(options: {
  refreshResult?: TokenSet;
  refreshError?: string;
  usesAccessToken?: boolean;
  noRefresh?: boolean;
}): { provider: SocialProvider; seen: () => string | null } {
  let seen: string | null = null;
  const provider = {
    platform: "youtube",
    usesPkce: false,
    buildAuthUrl: () => "https://example.invalid",
    exchangeCode: async () => {
      throw new Error("non utilisé");
    },
    refreshUsesAccessToken: options.usesAccessToken ?? false,
    ...(options.noRefresh
      ? {}
      : {
          refresh: async (token: string) => {
            seen = token;
            if (options.refreshError) throw new Error(options.refreshError);
            return options.refreshResult!;
          },
        }),
  } as unknown as SocialProvider;
  return { provider, seen: () => seen };
}

/** Crée un compte social avec les secrets demandés dans Vault. */
async function makeAccount(input: {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}) {
  const accessId = await vaultStore(admin, input.accessToken, "c85/access");
  const refreshId = input.refreshToken
    ? await vaultStore(admin, input.refreshToken, "c85/refresh")
    : null;
  const { data, error } = await admin
    .from("social_accounts")
    .insert({
      workspace_id: workspaceId,
      platform: "youtube",
      provider_account_id: `UC-${randomUUID().slice(0, 8)}`,
      display_name: "Chaîne de test",
      access_token_id: accessId,
      refresh_token_id: refreshId,
      token_expires_at: input.expiresAt,
      refresh_expires_at: null,
      scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
      connected_by: ownerId,
    })
    .select(
      "id, workspace_id, platform, provider_account_id, scopes, status, " +
        "access_token_id, refresh_token_id, token_expires_at, can_refresh",
    )
    .single();
  if (error) throw error;
  return { row: data as unknown as Record<string, unknown>, accessId, refreshId };
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((u) => u.email === EMAIL)) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C8.5 — rafraîchissement des jetons (chaîne réelle)", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "C85 Owner" },
    });
    if (error) throw error;
    ownerId = data.user.id;

    ownerClient = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NO_SESSION,
    );
    const { error: signInError } = await ownerClient.auth.signInWithPassword({
      email: EMAIL,
      password: PASSWORD,
    });
    if (signInError) throw signInError;

    const { data: ws, error: wsError } = await ownerClient.rpc("create_workspace", {
      p_name: "C85 WS",
    });
    if (wsError) throw wsError;
    workspaceId = (ws as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  // -------------------------------------------------------------------------
  // La colonne dérivée
  // -------------------------------------------------------------------------

  it("can_refresh est calculée par la base, et refresh_token_id reste invisible", async () => {
    const avec = await makeAccount({
      accessToken: "ya29.avec",
      refreshToken: "1//refresh",
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const sans = await makeAccount({
      accessToken: "ya29.sans",
      refreshToken: null,
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    expect(avec.row.can_refresh).toBe(true);
    expect(sans.row.can_refresh).toBe(false);

    // Ce que voit réellement un utilisateur connecté : le booléen, pas la
    // référence Vault.
    const { data: vue } = await ownerClient
      .from("social_accounts")
      .select("id, can_refresh, status, token_expires_at, refresh_expires_at")
      .eq("workspace_id", workspaceId);
    expect((vue ?? []).length).toBe(2);
    expect(JSON.stringify(vue)).not.toContain("token_id");

    // Et la colonne interdite reste interdite.
    const refuse = await ownerClient
      .from("social_accounts")
      .select("refresh_token_id")
      .eq("workspace_id", workspaceId);
    expect(refuse.error).not.toBeNull();

    // La colonne est GÉNÉRÉE : impossible de la désynchroniser à la main.
    const forcage = await admin
      .from("social_accounts")
      .update({ can_refresh: false })
      .eq("id", avec.row.id as string);
    expect(forcage.error).not.toBeNull();

    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  });

  it("le cas YouTube : jeton d'une heure expiré + refresh disponible reste actif", async () => {
    const { row } = await makeAccount({
      accessToken: "ya29.expire",
      refreshToken: "1//refresh",
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    // Exactement la ligne affichée dans l'interface.
    expect(
      effectiveStatus({
        status: row.status as "active",
        token_expires_at: row.token_expires_at as string,
        refresh_expires_at: null,
        can_refresh: row.can_refresh as boolean,
      }),
    ).toBe("active");
    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  });

  // -------------------------------------------------------------------------
  // Le rafraîchissement
  // -------------------------------------------------------------------------

  it("jeton encore valide : renvoyé tel quel, aucun appel au provider", async () => {
    const { row } = await makeAccount({
      accessToken: "ya29.valide",
      refreshToken: "1//refresh",
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const { provider, seen } = fakeProvider({ refreshResult: {} as TokenSet });

    const result = await getUsableAccessToken({ db: admin }, provider, row as never);
    expect(result).toEqual({ ok: true, accessToken: "ya29.valide", refreshed: false });
    expect(seen()).toBeNull();
    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  });

  it("jeton proche de l'échéance : renouvelé par anticipation", async () => {
    // Encore valide, mais pour moins que la marge : publier avec lui serait
    // risquer une expiration en plein transfert.
    const { row } = await makeAccount({
      accessToken: "ya29.bientot",
      refreshToken: "1//refresh",
      expiresAt: new Date(Date.now() + REFRESH_MARGIN_MS / 2).toISOString(),
    });
    const { provider, seen } = fakeProvider({
      refreshResult: {
        accessToken: "ya29.NOUVEAU",
        refreshToken: null,
        expiresAt: new Date(Date.now() + HOUR).toISOString(),
        refreshExpiresAt: null,
        scopes: [],
      },
    });

    const result = await getUsableAccessToken({ db: admin }, provider, row as never);
    expect(result).toMatchObject({ ok: true, accessToken: "ya29.NOUVEAU", refreshed: true });
    expect(seen()).toBe("1//refresh");
    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  });

  it("rafraîchissement réussi : rotation complète des secrets, ancien détruit", async () => {
    const { row, accessId, refreshId } = await makeAccount({
      accessToken: "ya29.ancien",
      refreshToken: "1//ancien",
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const nouvelleEcheance = new Date(Date.now() + HOUR).toISOString();
    const { provider } = fakeProvider({
      refreshResult: {
        accessToken: "ya29.nouveau",
        // TikTok fait tourner le refresh token : on doit adopter le nouveau.
        refreshToken: "1//nouveau",
        expiresAt: nouvelleEcheance,
        refreshExpiresAt: null,
        scopes: [],
      },
    });

    const result = await getUsableAccessToken({ db: admin }, provider, row as never);
    expect(result).toMatchObject({ ok: true, accessToken: "ya29.nouveau", refreshed: true });

    const { data: apres } = await admin
      .from("social_accounts")
      .select("access_token_id, refresh_token_id, token_expires_at, status, status_detail, can_refresh")
      .eq("id", row.id as string)
      .single();

    expect(await vaultRead(admin, apres!.access_token_id as string)).toBe("ya29.nouveau");
    expect(await vaultRead(admin, apres!.refresh_token_id as string)).toBe("1//nouveau");
    expect(apres!.status).toBe("active");
    expect(apres!.status_detail).toBeNull();
    expect(apres!.can_refresh).toBe(true);
    expect(new Date(apres!.token_expires_at as string).getTime()).toBeGreaterThan(Date.now());

    // Les anciens secrets ne traînent pas dans Vault.
    expect(await vaultRead(admin, accessId)).toBeNull();
    expect(await vaultRead(admin, refreshId!)).toBeNull();

    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  });

  it("la plateforme ne renvoie pas de nouveau refresh token : l'ancien est conservé", async () => {
    // Cas Google : seul l'access token est renouvelé.
    const { row, refreshId } = await makeAccount({
      accessToken: "ya29.ancien",
      refreshToken: "1//stable",
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const { provider } = fakeProvider({
      refreshResult: {
        accessToken: "ya29.nouveau",
        refreshToken: null,
        expiresAt: new Date(Date.now() + HOUR).toISOString(),
        refreshExpiresAt: null,
        scopes: [],
      },
    });

    await getUsableAccessToken({ db: admin }, provider, row as never);
    const { data: apres } = await admin
      .from("social_accounts")
      .select("refresh_token_id, can_refresh")
      .eq("id", row.id as string)
      .single();

    expect(apres!.refresh_token_id).toBe(refreshId);
    expect(await vaultRead(admin, refreshId!)).toBe("1//stable");
    expect(apres!.can_refresh).toBe(true);
    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  });

  // -------------------------------------------------------------------------
  // Les refus
  // -------------------------------------------------------------------------

  it("autorisation retirée (invalid_grant) : compte marqué révoqué", async () => {
    const { row } = await makeAccount({
      accessToken: "ya29.mort",
      refreshToken: "1//mort",
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const { provider } = fakeProvider({ refreshError: "google refresh: HTTP 400 invalid_grant" });

    const result = await getUsableAccessToken({ db: admin }, provider, row as never);
    expect(result).toEqual({ ok: false, code: "needs_reconnect" });

    const { data: apres } = await admin
      .from("social_accounts")
      .select("status, status_detail")
      .eq("id", row.id as string)
      .single();
    expect(apres!.status).toBe("revoked");
    expect(apres!.status_detail).toBe("refresh_revoked");
    // L'interface propose donc une reconnexion, au lieu d'échouer en silence.
    expect(
      effectiveStatus({
        status: "revoked",
        token_expires_at: null,
        refresh_expires_at: null,
        can_refresh: true,
      }),
    ).toBe("revoked");
    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  });

  it("panne passagère : compte en erreur, reconnexion proposée sans crier à la révocation", async () => {
    const { row } = await makeAccount({
      accessToken: "ya29.panne",
      refreshToken: "1//panne",
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const { provider } = fakeProvider({ refreshError: "google refresh: HTTP 503" });

    const result = await getUsableAccessToken({ db: admin }, provider, row as never);
    expect(result).toEqual({ ok: false, code: "needs_reconnect" });

    const { data: apres } = await admin
      .from("social_accounts")
      .select("status, status_detail")
      .eq("id", row.id as string)
      .single();
    expect(apres!.status).toBe("error");
    expect(apres!.status_detail).toBe("refresh_failed");
    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  });

  it("jeton expiré sans aucun moyen de rafraîchir : reconnexion exigée", async () => {
    const { row } = await makeAccount({
      accessToken: "ya29.seul",
      refreshToken: null,
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const { provider } = fakeProvider({ noRefresh: true });

    const result = await getUsableAccessToken({ db: admin }, provider, row as never);
    expect(result).toEqual({ ok: false, code: "needs_reconnect" });
    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  });

  it("Instagram : le rafraîchissement consomme l'ACCESS token, pas un refresh token", async () => {
    const { row } = await makeAccount({
      accessToken: "IGAA.courant",
      refreshToken: null,
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const { provider, seen } = fakeProvider({
      usesAccessToken: true,
      refreshResult: {
        accessToken: "IGAA.renouvele",
        refreshToken: null,
        expiresAt: new Date(Date.now() + HOUR).toISOString(),
        refreshExpiresAt: null,
        scopes: [],
      },
    });

    const result = await getUsableAccessToken({ db: admin }, provider, row as never);
    expect(result).toMatchObject({ ok: true, accessToken: "IGAA.renouvele" });
    // C'est bien le jeton courant qui a été présenté, faute de refresh token.
    expect(seen()).toBe("IGAA.courant");
    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  });

  it("jeton sans date d'expiration (Page Facebook) : jamais rafraîchi", async () => {
    const { row } = await makeAccount({
      accessToken: "EAA.page",
      refreshToken: null,
      expiresAt: null,
    });
    const { provider, seen } = fakeProvider({ refreshResult: {} as TokenSet });

    const result = await getUsableAccessToken({ db: admin }, provider, row as never);
    expect(result).toEqual({ ok: true, accessToken: "EAA.page", refreshed: false });
    expect(seen()).toBeNull();
    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  });
});
