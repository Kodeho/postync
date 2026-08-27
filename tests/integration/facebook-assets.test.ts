/**
 * C8.4c — sélection d'actifs (Pages Facebook) contre la VRAIE base.
 *
 * Le provider est simulé, mais le brouillon, Vault, les RLS, le quota et les
 * lignes `social_accounts` sont authentiques. Ce qu'on éprouve ici est
 * exactement ce que Facebook introduit et que les trois autres réseaux
 * n'avaient pas : UNE autorisation, PLUSIEURS comptes publiables.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectSelectedAssets,
  listSelectableAssets,
  type AssetsDeps,
} from "@/server/social/assets";
import {
  createConnectionDraft,
  readConnectionDraft,
} from "@/server/social/connection-draft";
import type { SocialAsset, SocialProvider } from "@/server/social/providers/types";
import { vaultRead } from "@/server/social/vault";

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
const PASSWORD = `C84c-${randomUUID()}`;
const USERS = {
  owner: "postync-c84c-owner@example.com",
  outsider: "postync-c84c-outsider@example.com",
} as const;
type Key = keyof typeof USERS;

const USER_TOKEN = "EAA.jeton-utilisateur-secret";
const PAGE_A = { id: "100000000000001", token: "EAA.page-a-secret" };
const PAGE_B = { id: "100000000000002", token: "EAA.page-b-secret" };
const PAGE_READONLY = { id: "100000000000003", token: "EAA.page-c-secret" };

let admin: SupabaseClient;
const ids: Record<Key, string> = { owner: "", outsider: "" };
const clients: Record<Key, SupabaseClient> = {} as Record<Key, SupabaseClient>;
let workspaceId = "";
let otherWorkspaceId = "";
let slug = "";

function pages(): SocialAsset[] {
  return [
    { assetId: PAGE_A.id, name: "Page A", avatarUrl: null, token: PAGE_A.token, canPublish: true },
    { assetId: PAGE_B.id, name: "Page B", avatarUrl: null, token: PAGE_B.token, canPublish: true },
    {
      assetId: PAGE_READONLY.id,
      name: "Page lecture seule",
      avatarUrl: null,
      token: PAGE_READONLY.token,
      canPublish: false,
    },
  ];
}

/** Provider simulé exposant des actifs, et notant le jeton qu'il reçoit. */
function fakeProvider(assets: SocialAsset[] = pages()): {
  provider: SocialProvider;
  seenToken: () => string | null;
} {
  let seen: string | null = null;
  const provider = {
    platform: "facebook",
    usesPkce: false,
    buildAuthUrl: () => "https://example.invalid",
    exchangeCode: async () => {
      throw new Error("non utilisé");
    },
    assets: {
      async listAssets(userAccessToken: string) {
        seen = userAccessToken;
        return assets;
      },
    },
  } as unknown as SocialProvider;
  return { provider, seenToken: () => seen };
}

function deps(provider: SocialProvider, quota = 10): AssetsDeps {
  return {
    db: admin,
    getProvider: (platform) => (platform === "facebook" ? provider : null),
    getQuota: async () => quota,
  };
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const emails = new Set<string>(Object.values(USERS));
  for (const u of data.users.filter((u) => emails.has(u.email ?? ""))) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

/** Repart d'un état propre : ni comptes, ni brouillons. */
async function reset() {
  await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  await admin.from("social_connection_drafts").delete().eq("workspace_id", workspaceId);
}

async function newDraft(): Promise<string> {
  return createConnectionDraft(admin, {
    workspaceId,
    userId: ids.owner,
    platform: "facebook",
    redirectSlug: slug,
    userAccessToken: USER_TOKEN,
    scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
  });
}

describe.skipIf(!CONFIGURED)("C8.4c — sélection des Pages (chaîne réelle)", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    for (const key of Object.keys(USERS) as Key[]) {
      const { data, error } = await admin.auth.admin.createUser({
        email: USERS[key],
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: `C84c ${key}` },
      });
      if (error) throw error;
      ids[key] = data.user.id;
      const client = createClient(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        NO_SESSION,
      );
      const { error: signInError } = await client.auth.signInWithPassword({
        email: USERS[key],
        password: PASSWORD,
      });
      if (signInError) throw signInError;
      clients[key] = client;
    }

    const { data: ws, error } = await clients.owner.rpc("create_workspace", { p_name: "C84c WS" });
    if (error) throw error;
    workspaceId = (ws as { id: string }).id;
    slug = (ws as { slug: string }).slug;

    const { data: ws2, error: e2 } = await clients.outsider.rpc("create_workspace", {
      p_name: "C84c Autre",
    });
    if (e2) throw e2;
    otherWorkspaceId = (ws2 as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Le brouillon
  // -------------------------------------------------------------------------

  it("le brouillon garde le jeton utilisateur dans Vault, jamais en clair", async () => {
    await reset();
    const draftId = await newDraft();

    const { data: row } = await admin
      .from("social_connection_drafts")
      .select("user_token_id, platform, workspace_id, user_id, expires_at")
      .eq("id", draftId)
      .single();

    expect(row!.platform).toBe("facebook");
    expect(row!.workspace_id).toBe(workspaceId);
    expect(row!.user_id).toBe(ids.owner);
    expect(new Date(row!.expires_at).getTime()).toBeGreaterThan(Date.now());

    // Le jeton n'est nulle part en clair dans la table.
    const { data: all } = await admin.from("social_connection_drafts").select("*").eq("id", draftId);
    expect(JSON.stringify(all)).not.toContain(USER_TOKEN);
    // Mais il est bien lisible depuis Vault, côté service_role seulement.
    expect(await vaultRead(admin, row!.user_token_id as string)).toBe(USER_TOKEN);
  });

  it("la table des brouillons est invisible pour un utilisateur connecté", async () => {
    await reset();
    await newDraft();
    const { data, error } = await clients.owner.from("social_connection_drafts").select("id");
    // Ni grant ni politique : lecture refusée ou vide, jamais de contenu.
    expect(data ?? []).toHaveLength(0);
    if (error) expect(error.code).toBeDefined();
  });

  it("un brouillon d'un autre utilisateur ou workspace est introuvable", async () => {
    await reset();
    const draftId = await newDraft();

    expect(
      await readConnectionDraft(admin, { draftId, workspaceId, userId: ids.outsider }),
    ).toBeNull();
    expect(
      await readConnectionDraft(admin, { draftId, workspaceId: otherWorkspaceId, userId: ids.owner }),
    ).toBeNull();
    // Le vrai propriétaire, lui, le retrouve.
    expect(
      await readConnectionDraft(admin, { draftId, workspaceId, userId: ids.owner }),
    ).not.toBeNull();
  });

  it("un brouillon périmé est refusé ET supprimé, avec son jeton", async () => {
    await reset();
    const draftId = await newDraft();
    const { data: before } = await admin
      .from("social_connection_drafts")
      .select("user_token_id")
      .eq("id", draftId)
      .single();
    const tokenId = before!.user_token_id as string;

    // La contrainte `social_connection_drafts_ttl_check` impose
    // `expires_at > created_at` : reculer la seule échéance produit une ligne
    // INVALIDE, l'écriture est refusée et le brouillon reste vivant. Le test ne
    // passait donc que si plus d'une seconde s'écoulait entre la création et
    // cette mise à jour — une course, pas une vérification. On recule les DEUX
    // dates, et on exige que l'écriture ait réellement eu lieu.
    const { error: peremption } = await admin
      .from("social_connection_drafts")
      .update({
        created_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() - 30_000).toISOString(),
      })
      .eq("id", draftId);
    expect(peremption).toBeNull();

    expect(await readConnectionDraft(admin, { draftId, workspaceId, userId: ids.owner })).toBeNull();
    const { count } = await admin
      .from("social_connection_drafts")
      .select("*", { count: "exact", head: true })
      .eq("id", draftId);
    expect(count).toBe(0);
    // Le jeton abandonné ne survit pas au brouillon.
    expect(await vaultRead(admin, tokenId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  it("la liste des Pages ne contient AUCUN jeton", async () => {
    await reset();
    const draftId = await newDraft();
    const { provider, seenToken } = fakeProvider();

    const result = await listSelectableAssets(deps(provider), {
      draftId,
      workspaceId,
      userId: ids.owner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Le provider a bien reçu le jeton relu dans Vault.
    expect(seenToken()).toBe(USER_TOKEN);
    // Mais rien de secret ne ressort de cette couche.
    const serialise = JSON.stringify(result.assets);
    expect(serialise).not.toContain(PAGE_A.token);
    expect(serialise).not.toContain(USER_TOKEN);
    expect(serialise).not.toContain("token");

    expect(result.assets.map((a) => a.assetId)).toEqual([
      PAGE_A.id,
      PAGE_B.id,
      PAGE_READONLY.id,
    ]);
    expect(result.assets.find((a) => a.assetId === PAGE_READONLY.id)!.canPublish).toBe(false);
    expect(result.assets.every((a) => !a.alreadyConnected)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Connexion
  // -------------------------------------------------------------------------

  it("une ligne par Page, jeton de PAGE dans Vault, jeton utilisateur détruit", async () => {
    await reset();
    const draftId = await newDraft();
    const { data: draftRow } = await admin
      .from("social_connection_drafts")
      .select("user_token_id")
      .eq("id", draftId)
      .single();
    const userTokenId = draftRow!.user_token_id as string;

    const { provider } = fakeProvider();
    const result = await connectSelectedAssets(deps(provider), {
      draftId,
      workspaceId,
      userId: ids.owner,
      assetIds: [PAGE_A.id, PAGE_B.id],
    });

    expect(result).toMatchObject({ ok: true, connected: 2, slug });

    const { data: rows } = await admin
      .from("social_accounts")
      .select("provider_account_id, display_name, access_token_id, refresh_token_id, token_expires_at, status, scopes")
      .eq("workspace_id", workspaceId)
      .order("provider_account_id");
    expect(rows).toHaveLength(2);

    for (const row of rows ?? []) {
      const attendu = row.provider_account_id === PAGE_A.id ? PAGE_A.token : PAGE_B.token;
      // Chaque Page porte SON propre jeton, pas celui de l'utilisateur.
      expect(await vaultRead(admin, row.access_token_id as string)).toBe(attendu);
      expect(row.refresh_token_id).toBeNull();
      // Un jeton de Page n'a pas de date d'expiration.
      expect(row.token_expires_at).toBeNull();
      expect(row.status).toBe("active");
      expect(row.scopes).toContain("pages_manage_posts");
    }

    // Le brouillon a disparu, et le jeton utilisateur avec lui.
    const { count } = await admin
      .from("social_connection_drafts")
      .select("*", { count: "exact", head: true })
      .eq("id", draftId);
    expect(count).toBe(0);
    expect(await vaultRead(admin, userTokenId)).toBeNull();
  });

  it("une Page non publiable est refusée, rien n'est connecté", async () => {
    await reset();
    const draftId = await newDraft();
    const { provider } = fakeProvider();

    const result = await connectSelectedAssets(deps(provider), {
      draftId,
      workspaceId,
      userId: ids.owner,
      assetIds: [PAGE_A.id, PAGE_READONLY.id],
    });
    expect(result).toMatchObject({ ok: false, code: "not_publishable" });

    const { count } = await admin
      .from("social_accounts")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    expect(count).toBe(0);
  });

  it("un identifiant qui n'appartient pas au brouillon est écarté", async () => {
    await reset();
    const draftId = await newDraft();
    const { provider } = fakeProvider();

    const result = await connectSelectedAssets(deps(provider), {
      draftId,
      workspaceId,
      userId: ids.owner,
      assetIds: ["999999999999999"],
    });
    // Aucun actif retenu : on ne fabrique pas une ligne à partir d'un id reçu.
    expect(result).toMatchObject({ ok: false, code: "draft_not_found" });
  });

  it("quota du plan : dépassement refusé, aucune ligne créée", async () => {
    await reset();
    const draftId = await newDraft();
    const { provider } = fakeProvider();

    // Plan à 1 compte, deux Pages demandées.
    const result = await connectSelectedAssets(deps(provider, 1), {
      draftId,
      workspaceId,
      userId: ids.owner,
      assetIds: [PAGE_A.id, PAGE_B.id],
    });
    expect(result).toMatchObject({ ok: false, code: "quota_exceeded" });

    const { count } = await admin
      .from("social_accounts")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    expect(count).toBe(0);
  });

  it("reconnexion : la ligne est mise à jour, le jeton tourne, le quota ne bouge pas", async () => {
    await reset();

    // Première connexion.
    const premier = await newDraft();
    await connectSelectedAssets(deps(fakeProvider().provider), {
      draftId: premier,
      workspaceId,
      userId: ids.owner,
      assetIds: [PAGE_A.id],
    });
    const { data: avant } = await admin
      .from("social_accounts")
      .select("id, access_token_id")
      .eq("workspace_id", workspaceId)
      .single();
    const ancienSecret = avant!.access_token_id as string;

    // Reconnexion avec un nouveau jeton de Page, quota volontairement à 1.
    const second = await newDraft();
    const rotated = pages().map((p) =>
      p.assetId === PAGE_A.id ? { ...p, token: "EAA.page-a-NOUVEAU", name: "Page A renommée" } : p,
    );
    const result = await connectSelectedAssets(deps(fakeProvider(rotated).provider, 1), {
      draftId: second,
      workspaceId,
      userId: ids.owner,
      assetIds: [PAGE_A.id],
    });
    // Une reconnexion ne consomme pas de quota supplémentaire.
    expect(result).toMatchObject({ ok: true, connected: 1 });

    const { data: apres } = await admin
      .from("social_accounts")
      .select("id, access_token_id, display_name")
      .eq("workspace_id", workspaceId)
      .single();
    // Même ligne, pas de doublon.
    expect(apres!.id).toBe(avant!.id);
    expect(apres!.display_name).toBe("Page A renommée");
    expect(await vaultRead(admin, apres!.access_token_id as string)).toBe("EAA.page-a-NOUVEAU");
    // L'ancien secret a été purgé après le succès.
    expect(await vaultRead(admin, ancienSecret)).toBeNull();
  });

  it("les Pages déjà connectées sont signalées lors d'une nouvelle sélection", async () => {
    await reset();
    const premier = await newDraft();
    await connectSelectedAssets(deps(fakeProvider().provider), {
      draftId: premier,
      workspaceId,
      userId: ids.owner,
      assetIds: [PAGE_A.id],
    });

    const second = await newDraft();
    const result = await listSelectableAssets(deps(fakeProvider().provider), {
      draftId: second,
      workspaceId,
      userId: ids.owner,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assets.find((a) => a.assetId === PAGE_A.id)!.alreadyConnected).toBe(true);
    expect(result.assets.find((a) => a.assetId === PAGE_B.id)!.alreadyConnected).toBe(false);
  });

  it("cascade — supprimer le workspace emporte brouillons et jetons", async () => {
    const { data: ws } = await clients.owner.rpc("create_workspace", { p_name: "C84c Jetable" });
    const jetableId = (ws as { id: string }).id;
    const draftId = await createConnectionDraft(admin, {
      workspaceId: jetableId,
      userId: ids.owner,
      platform: "facebook",
      redirectSlug: (ws as { slug: string }).slug,
      userAccessToken: "EAA.jeton-jetable",
      scopes: [],
    });
    const { data: row } = await admin
      .from("social_connection_drafts")
      .select("user_token_id")
      .eq("id", draftId)
      .single();
    const tokenId = row!.user_token_id as string;

    await admin.from("workspaces").delete().eq("id", jetableId);

    const { count } = await admin
      .from("social_connection_drafts")
      .select("*", { count: "exact", head: true })
      .eq("id", draftId);
    expect(count).toBe(0);
    expect(await vaultRead(admin, tokenId)).toBeNull();
  });
});
