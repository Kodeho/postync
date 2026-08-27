/**
 * C9.3 — publier un média de la BIBLIOTHÈQUE, contre la vraie base et le vrai
 * bucket. Le provider est simulé : ce qu'on éprouve, c'est la résolution du
 * média, la compatibilité par réseau, et surtout le fait qu'aucune URL signée
 * ne se retrouve enregistrée.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { finalizeUpload, requestUpload, type MediaDeps } from "@/server/media/library";
import { publishToSocialAccount, type PublishDeps } from "@/server/social/publish";
import type { ContainerStatus, SocialProvider } from "@/server/social/providers/types";
import { vaultStore } from "@/server/social/vault";

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
const PASSWORD = `C93-${randomUUID()}`;
const EMAIL = "postync-c93-owner@example.com";
const OCTETS = new Uint8Array(4096).fill(3);

let admin: SupabaseClient;
let ownerClient: SupabaseClient;
let ownerId = "";
let workspaceId = "";
let accountId = "";

/** Provider simulé qui note l'URL réellement transmise à la plateforme. */
function fakeProvider(): { provider: SocialProvider; urlRecue: () => string | null } {
  let url: string | null = null;
  const provider = {
    platform: "facebook",
    usesPkce: false,
    buildAuthUrl: () => "https://example.invalid",
    exchangeCode: async () => {
      throw new Error("non utilisé");
    },
    publisher: {
      requiredScopes: ["pages_manage_posts"],
      supportedMediaKinds: ["reel"] as const,
      async createContainer(input: { mediaUrl: string }) {
        url = input.mediaUrl;
        return "container-lib";
      },
      async containerStatus(): Promise<ContainerStatus> {
        return "ready";
      },
      async publishContainer() {
        return { providerMediaId: "media-lib" };
      },
      async fetchPermalink() {
        return "https://www.facebook.com/reel/media-lib/";
      },
    },
  } as unknown as SocialProvider;
  return { provider, urlRecue: () => url };
}

function publishDeps(provider: SocialProvider): PublishDeps {
  return {
    db: admin,
    getProvider: (p) => (p === "facebook" ? provider : null),
    getMonthlyQuota: async () => 100,
    sleep: async () => undefined,
  };
}

const mediaDeps: MediaDeps = {
  get db() {
    return admin;
  },
  getStorageQuotaGb: async () => 5,
};

/** Dépose un média conforme aux Reels Facebook et le rend prêt. */
async function mediaPret(probe: {
  width: number;
  height: number;
  durationSeconds: number;
}): Promise<string> {
  const demande = await requestUpload(mediaDeps, {
    workspaceId,
    userId: ownerId,
    filename: `test-${randomUUID().slice(0, 6)}.mp4`,
    mimeType: "video/mp4",
    byteSize: OCTETS.length,
  });
  if (!demande.ok) throw new Error("upload refusé");
  await fetch(demande.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "video/mp4" },
    body: OCTETS,
  });
  await finalizeUpload(admin, {
    workspaceId,
    assetId: demande.assetId,
    probe: { ...probe, videoCodec: "avc1", fastStart: true },
  });
  return demande.assetId;
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((u) => u.email === EMAIL)) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C9.3 — publier depuis la médiathèque", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "C93 Owner" },
    });
    if (error) throw error;
    ownerId = data.user.id;

    ownerClient = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NO_SESSION,
    );
    const { error: e } = await ownerClient.auth.signInWithPassword({
      email: EMAIL,
      password: PASSWORD,
    });
    if (e) throw e;

    const { data: ws, error: wsError } = await ownerClient.rpc("create_workspace", {
      p_name: "C93 WS",
    });
    if (wsError) throw wsError;
    workspaceId = (ws as { id: string }).id;

    const tokenId = await vaultStore(admin, "EAA.page-c93", "c93/access");
    const { data: account, error: accError } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "facebook",
        provider_account_id: "1290000000000001",
        display_name: "Page C93",
        access_token_id: tokenId,
        scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
        connected_by: ownerId,
      })
      .select("id")
      .single();
    if (accError) throw accError;
    accountId = (account as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  it("média compatible : publié, URL signée transmise mais JAMAIS enregistrée", async () => {
    const assetId = await mediaPret({ width: 720, height: 1280, durationSeconds: 30 });
    const { provider, urlRecue } = fakeProvider();

    const outcome = await publishToSocialAccount(publishDeps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaAssetId: assetId,
      caption: "Depuis la bibliothèque",
    });
    expect(outcome).toMatchObject({ ok: true, status: "published" });

    // La plateforme a bien reçu une URL signée, utilisable.
    const url = urlRecue();
    expect(url).toContain("/object/sign/media/");
    expect(url).toContain("token=");
    const recuperation = await fetch(url!);
    expect(recuperation.status).toBe(200);

    // Mais la ligne ne garde que la CLÉ de l'objet.
    const { data: row } = await admin
      .from("social_publications")
      .select("media_url, media_asset_id, status, provider_media_id")
      .eq("workspace_id", workspaceId)
      .single();
    expect(row!.media_asset_id).toBe(assetId);
    expect(row!.media_url).toMatch(new RegExp(`^${workspaceId}/`));
    expect(row!.media_url).not.toContain("token=");
    expect(row!.media_url).not.toContain("/object/sign/");
    expect(JSON.stringify(row)).not.toContain("token=");

    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
    await admin.from("media_assets").delete().eq("id", assetId);
  }, 60_000);

  it("média incompatible avec CE réseau : refusé avant tout appel distant", async () => {
    // 16:9 : passe sur Instagram, refusé par Facebook.
    const assetId = await mediaPret({ width: 1280, height: 720, durationSeconds: 10 });
    const { provider, urlRecue } = fakeProvider();

    const outcome = await publishToSocialAccount(publishDeps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaAssetId: assetId,
      caption: null,
    });
    expect(outcome).toEqual({ ok: false, code: "media_incompatible", publicationId: null });
    // Aucune URL signée n'a été forgée pour une publication vouée à l'échec.
    expect(urlRecue()).toBeNull();

    const { count } = await admin
      .from("social_publications")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    expect(count).toBe(0);

    await admin.from("media_assets").delete().eq("id", assetId);
  }, 60_000);

  it("média d'un autre workspace ou pas encore prêt : introuvable", async () => {
    const demande = await requestUpload(mediaDeps, {
      workspaceId,
      userId: ownerId,
      filename: "pas-pret.mp4",
      mimeType: "video/mp4",
      byteSize: 1024,
    });
    if (!demande.ok) throw new Error("upload refusé");

    const { provider } = fakeProvider();
    // Statut `uploading` : non publiable.
    expect(
      await publishToSocialAccount(publishDeps(provider), {
        workspaceId,
        socialAccountId: accountId,
        requestedBy: ownerId,
        mediaKind: "reel",
        mediaAssetId: demande.assetId,
        caption: null,
      }),
    ).toEqual({ ok: false, code: "media_not_found", publicationId: null });

    // Identifiant inventé : introuvable également.
    expect(
      await publishToSocialAccount(publishDeps(provider), {
        workspaceId,
        socialAccountId: accountId,
        requestedBy: ownerId,
        mediaKind: "reel",
        mediaAssetId: randomUUID(),
        caption: null,
      }),
    ).toEqual({ ok: false, code: "media_not_found", publicationId: null });

    await admin.from("media_assets").delete().eq("id", demande.assetId);
  }, 60_000);

  it("le chemin par URL manuelle reste fonctionnel", async () => {
    // Aucune régression tant que la transition n'est pas terminée.
    const { provider, urlRecue } = fakeProvider();
    const outcome = await publishToSocialAccount(publishDeps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/externe.mp4",
      caption: null,
    });
    expect(outcome).toMatchObject({ ok: true, status: "published" });
    expect(urlRecue()).toBe("https://cdn.example.com/externe.mp4");

    const { data: row } = await admin
      .from("social_publications")
      .select("media_url, media_asset_id")
      .eq("workspace_id", workspaceId)
      .single();
    expect(row!.media_url).toBe("https://cdn.example.com/externe.mp4");
    expect(row!.media_asset_id).toBeNull();

    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  }, 60_000);

  it("supprimer un média laisse la trace de publication intacte", async () => {
    const assetId = await mediaPret({ width: 720, height: 1280, durationSeconds: 15 });
    const { provider } = fakeProvider();
    await publishToSocialAccount(publishDeps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaAssetId: assetId,
      caption: null,
    });

    await admin.from("media_assets").delete().eq("id", assetId);

    // `on delete set null` : l'historique survit au média.
    const { data: row } = await admin
      .from("social_publications")
      .select("media_asset_id, status, provider_media_id")
      .eq("workspace_id", workspaceId)
      .single();
    expect(row!.media_asset_id).toBeNull();
    expect(row!.status).toBe("published");
    expect(row!.provider_media_id).toBe("media-lib");

    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  }, 60_000);
});
