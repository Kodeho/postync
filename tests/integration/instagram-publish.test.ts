/**
 * C8.4b — orchestration de la publication contre la VRAIE base : RLS réelle,
 * Vault réel, quota réel, isolation réelle.
 *
 * Le PROVIDER est simulé (aucun appel à Instagram), mais tout le reste est
 * authentique : c'est précisément l'orchestration qu'on veut éprouver —
 * appartenance du compte au workspace, scopes réellement accordés, quota du
 * plan, lecture du token dans Vault, persistance et reprise.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  countsTowardQuota,
  currentMonthRange,
  isPublishableMediaUrl,
  publishToSocialAccount,
  resumePublication,
  type PublishDeps,
} from "@/server/social/publish";
import { SocialPublishError, type ContainerStatus, type SocialProvider } from "@/server/social/providers/types";
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
const PASSWORD = `C84b-${randomUUID()}`;
const USERS = {
  owner: "postync-c84b-owner@example.com",
  outsider: "postync-c84b-outsider@example.com",
} as const;
type Key = keyof typeof USERS;

const PUBLISH_SCOPE = "instagram_business_content_publish";
const IG_ACCOUNT_ID = "17841400000000042";
const MEDIA_URL = "https://cdn.example.com/reel.mp4";

let admin: SupabaseClient;
const ids: Record<Key, string> = { owner: "", outsider: "" };
const clients: Record<Key, SupabaseClient> = {} as Record<Key, SupabaseClient>;
let workspaceId = "";
let otherWorkspaceId = "";
let accountId = "";
let accessTokenId = "";

/** Trace des appels reçus par le provider simulé. */
type ProviderCalls = {
  createdWith: { accessToken: string; caption: string | null } | null;
  publishedContainer: string | null;
  statusCalls: number;
};

/**
 * Provider simulé : renvoie les statuts programmés, dans l'ordre. Il note le
 * token qu'il a reçu, ce qui prouve que la lecture Vault a bien eu lieu.
 */
function fakeProvider(
  statuses: ContainerStatus[],
  options: { failCreate?: boolean } = {},
): { provider: SocialProvider; calls: ProviderCalls } {
  const calls: ProviderCalls = { createdWith: null, publishedContainer: null, statusCalls: 0 };
  let index = 0;

  const provider = {
    platform: "instagram",
    usesPkce: false,
    buildAuthUrl: () => "https://example.invalid",
    exchangeCode: async () => {
      throw new Error("non utilisé");
    },
    fetchIdentity: async () => {
      throw new Error("non utilisé");
    },
    publisher: {
      requiredScopes: [PUBLISH_SCOPE],
      supportedMediaKinds: ["reel", "image"] as const,
      async createContainer(input: { accessToken: string; caption: string | null }) {
        if (options.failCreate) throw new SocialPublishError("http_400");
        calls.createdWith = { accessToken: input.accessToken, caption: input.caption };
        return "container-xyz";
      },
      async containerStatus(): Promise<ContainerStatus> {
        calls.statusCalls += 1;
        const status = statuses[Math.min(index, statuses.length - 1)];
        index += 1;
        return status;
      },
      async publishContainer(input: { containerId: string }) {
        calls.publishedContainer = input.containerId;
        return { providerMediaId: "media-123" };
      },
      async fetchPermalink() {
        return "https://www.instagram.com/reel/xyz/";
      },
    },
  } as unknown as SocialProvider;

  return { provider, calls };
}

/** `now` qui avance vite : la boucle d'attente se termine sans attendre. */
function fastClock(): () => number {
  let value = Date.now();
  return () => {
    value += 20_000;
    return value;
  };
}

function deps(provider: SocialProvider, quota = 100): PublishDeps {
  return {
    db: admin,
    getProvider: (platform) => (platform === "instagram" ? provider : null),
    getMonthlyQuota: async () => quota,
    sleep: async () => undefined,
    now: fastClock(),
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

/** Remet le compte et l'historique dans un état connu avant chaque scénario. */
async function resetPublications(scopes: string[] = ["instagram_business_basic", PUBLISH_SCOPE]) {
  await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  await admin.from("social_accounts").update({ scopes, status: "active" }).eq("id", accountId);
}

describe.skipIf(!CONFIGURED)("C8.4b — publication (orchestration réelle)", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    for (const key of Object.keys(USERS) as Key[]) {
      const { data, error } = await admin.auth.admin.createUser({
        email: USERS[key],
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: `C84b ${key}` },
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

    const { data: ws, error } = await clients.owner.rpc("create_workspace", { p_name: "C84b WS" });
    if (error) throw error;
    workspaceId = (ws as { id: string }).id;

    const { data: ws2, error: e2 } = await clients.owner.rpc("create_workspace", {
      p_name: "C84b Autre WS",
    });
    if (e2) throw e2;
    otherWorkspaceId = (ws2 as { id: string }).id;

    accessTokenId = await vaultStore(admin, "IGAA.secret-du-compte", "c84b/access");
    const { data: account, error: e3 } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        provider_account_id: IG_ACCOUNT_ID,
        display_name: "kodeho_studio",
        access_token_id: accessTokenId,
        scopes: ["instagram_business_basic", PUBLISH_SCOPE],
        connected_by: ids.owner,
      })
      .select("id")
      .single();
    if (e3) throw e3;
    accountId = (account as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Validation d'entrée (pure, avant toute écriture)
  // -------------------------------------------------------------------------

  it("URL de média : https public exigé, identifiants intégrés refusés", () => {
    expect(isPublishableMediaUrl("https://cdn.example.com/a.mp4")).toBe(true);
    // Meta doit pouvoir aller chercher le fichier : http est refusé.
    expect(isPublishableMediaUrl("http://cdn.example.com/a.mp4")).toBe(false);
    // Ne jamais transmettre d'identifiants à un tiers.
    expect(isPublishableMediaUrl("https://user:pass@cdn.example.com/a.mp4")).toBe(false);
    expect(isPublishableMediaUrl("file:///etc/passwd")).toBe(false);
    expect(isPublishableMediaUrl("pas-une-url")).toBe(false);
  });

  it("une publication en échec ne consomme pas le quota", () => {
    expect(countsTowardQuota("published")).toBe(true);
    expect(countsTowardQuota("pending")).toBe(true);
    expect(countsTowardQuota("failed")).toBe(false);
  });

  it("le mois de quota est un mois calendaire UTC", () => {
    const { start, end } = currentMonthRange(Date.UTC(2026, 7, 27, 15, 30));
    expect(start).toBe("2026-08-01T00:00:00.000Z");
    expect(end).toBe("2026-09-01T00:00:00.000Z");
  });

  it("URL invalide : refusée sans créer la moindre ligne", async () => {
    await resetPublications();
    const { provider } = fakeProvider(["ready"]);
    const outcome = await publishToSocialAccount(deps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: "http://cdn.example.com/reel.mp4",
      caption: null,
    });
    expect(outcome).toEqual({ ok: false, code: "invalid_media_url", publicationId: null });

    const { count } = await admin
      .from("social_publications")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    expect(count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Isolation et autorisations
  // -------------------------------------------------------------------------

  it("isolation — le compte d'un autre workspace est introuvable, rien n'est écrit", async () => {
    await resetPublications();
    const { provider, calls } = fakeProvider(["ready"]);
    const outcome = await publishToSocialAccount(deps(provider), {
      // Identifiant de compte RÉEL, mais workspace qui n'est pas le sien.
      workspaceId: otherWorkspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: null,
    });
    expect(outcome).toEqual({ ok: false, code: "account_not_found", publicationId: null });
    // Aucun appel distant n'a été tenté.
    expect(calls.createdWith).toBeNull();

    const { count } = await admin
      .from("social_publications")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", otherWorkspaceId);
    expect(count).toBe(0);
  });

  it("scope de publication non accordé : reconnexion demandée, aucun appel distant", async () => {
    await resetPublications(["instagram_business_basic"]);
    const { provider, calls } = fakeProvider(["ready"]);
    const outcome = await publishToSocialAccount(deps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: null,
    });
    expect(outcome).toEqual({ ok: false, code: "missing_scope", publicationId: null });
    expect(calls.createdWith).toBeNull();
  });

  it("compte non actif : publication refusée", async () => {
    await resetPublications();
    await admin.from("social_accounts").update({ status: "expired" }).eq("id", accountId);
    const { provider } = fakeProvider(["ready"]);
    const outcome = await publishToSocialAccount(deps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: null,
    });
    expect(outcome).toEqual({ ok: false, code: "account_inactive", publicationId: null });
    await admin.from("social_accounts").update({ status: "active" }).eq("id", accountId);
  });

  it("quota du plan atteint : refus AVANT tout appel distant", async () => {
    await resetPublications();
    // Une publication déjà comptée ce mois-ci, quota du plan à 1.
    await admin.from("social_publications").insert({
      workspace_id: workspaceId,
      social_account_id: accountId,
      platform: "instagram",
      provider_account_id: IG_ACCOUNT_ID,
      media_kind: "reel",
      media_url: MEDIA_URL,
      status: "published",
      provider_media_id: "media-precedent",
      published_at: new Date().toISOString(),
    });

    const { provider, calls } = fakeProvider(["ready"]);
    const outcome = await publishToSocialAccount(deps(provider, 1), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: null,
    });
    expect(outcome).toEqual({ ok: false, code: "quota_exceeded", publicationId: null });
    expect(calls.createdWith).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Parcours nominal
  // -------------------------------------------------------------------------

  it("nominal — conteneur prêt : publié, ligne complète, token lu dans Vault", async () => {
    await resetPublications();
    const { provider, calls } = fakeProvider(["ready"]);
    const outcome = await publishToSocialAccount(deps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: "Légende de test",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome).toMatchObject({ status: "published" });

    // Le provider a reçu le secret stocké dans Vault, pas autre chose.
    expect(calls.createdWith?.accessToken).toBe("IGAA.secret-du-compte");
    expect(calls.createdWith?.caption).toBe("Légende de test");
    expect(calls.publishedContainer).toBe("container-xyz");

    const { data: row } = await admin
      .from("social_publications")
      .select("status, provider_media_id, permalink, container_id, published_at, requested_by, media_url")
      .eq("workspace_id", workspaceId)
      .single();
    expect(row).toMatchObject({
      status: "published",
      provider_media_id: "media-123",
      permalink: "https://www.instagram.com/reel/xyz/",
      container_id: "container-xyz",
      requested_by: ids.owner,
      media_url: MEDIA_URL,
    });
    expect(row!.published_at).not.toBeNull();

    // Aucun token ne doit se retrouver dans la table.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("IGAA");
  });

  it("conteneur refusé par la plateforme : ligne en échec, code court", async () => {
    await resetPublications();
    const { provider } = fakeProvider(["failed"]);
    const outcome = await publishToSocialAccount(deps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: null,
    });
    expect(outcome).toMatchObject({ ok: false, code: "container_failed" });

    const { data: row } = await admin
      .from("social_publications")
      .select("status, status_detail, provider_media_id")
      .eq("workspace_id", workspaceId)
      .single();
    expect(row).toMatchObject({
      status: "failed",
      status_detail: "container_failed",
      provider_media_id: null,
    });
  });

  it("création du conteneur en échec : ligne en échec, quota non consommé ensuite", async () => {
    await resetPublications();
    const { provider } = fakeProvider(["ready"], { failCreate: true });
    const outcome = await publishToSocialAccount(deps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: null,
    });
    expect(outcome).toMatchObject({ ok: false, code: "provider_error" });

    const { data: row } = await admin
      .from("social_publications")
      .select("status, status_detail")
      .eq("workspace_id", workspaceId)
      .single();
    expect(row).toMatchObject({ status: "failed", status_detail: "http_400" });
  });

  // -------------------------------------------------------------------------
  // Reprise
  // -------------------------------------------------------------------------

  it("traitement encore en cours : ligne « pending » reprenable, média jamais réenvoyé", async () => {
    await resetPublications();
    const { provider, calls } = fakeProvider(["processing"]);
    const outcome = await publishToSocialAccount(deps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: null,
    });
    expect(outcome).toMatchObject({ ok: true, status: "pending" });
    const publicationId = outcome.ok ? outcome.publicationId : "";

    const { data: pending } = await admin
      .from("social_publications")
      .select("status, container_id")
      .eq("id", publicationId)
      .single();
    expect(pending).toMatchObject({ status: "pending", container_id: "container-xyz" });

    // Reprise : le conteneur est prêt cette fois.
    const resumed = fakeProvider(["ready"]);
    const second = await resumePublication(deps(resumed.provider), {
      workspaceId,
      publicationId,
    });
    expect(second).toMatchObject({ ok: true, status: "published" });
    // Le média n'a PAS été renvoyé : aucun conteneur recréé.
    expect(resumed.calls.createdWith).toBeNull();
    expect(resumed.calls.publishedContainer).toBe("container-xyz");
    // Le premier provider avait bien interrogé le statut plusieurs fois.
    expect(calls.statusCalls).toBeGreaterThan(1);

    const { data: row } = await admin
      .from("social_publications")
      .select("status, provider_media_id")
      .eq("id", publicationId)
      .single();
    expect(row).toMatchObject({ status: "published", provider_media_id: "media-123" });
  });

  it("reprise — publication d'un autre workspace : introuvable", async () => {
    await resetPublications();
    const { provider } = fakeProvider(["processing"]);
    const outcome = await publishToSocialAccount(deps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: null,
    });
    const publicationId = outcome.ok ? outcome.publicationId : "";

    const resumed = fakeProvider(["ready"]);
    const cross = await resumePublication(deps(resumed.provider), {
      workspaceId: otherWorkspaceId,
      publicationId,
    });
    expect(cross).toMatchObject({ ok: false, code: "account_not_found" });
    expect(resumed.calls.publishedContainer).toBeNull();
  });

  it("conteneur déjà publié côté plateforme : repris sans republier", async () => {
    await resetPublications();
    const { provider } = fakeProvider(["processing"]);
    const outcome = await publishToSocialAccount(deps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: null,
    });
    const publicationId = outcome.ok ? outcome.publicationId : "";

    const resumed = fakeProvider(["published"]);
    const second = await resumePublication(deps(resumed.provider), { workspaceId, publicationId });
    expect(second).toMatchObject({ ok: true, status: "published" });
    // Republier créerait un doublon sur le compte de l'utilisateur.
    expect(resumed.calls.publishedContainer).toBeNull();

    // On ne fait pas passer l'id du conteneur pour un id de média sans le dire.
    const { data: row } = await admin
      .from("social_publications")
      .select("status, provider_media_id, permalink, status_detail")
      .eq("id", publicationId)
      .single();
    expect(row).toMatchObject({
      status: "published",
      provider_media_id: "container-xyz",
      status_detail: "media_id_is_container",
      // Un permalien lu sur un id de conteneur n'aurait aucun sens.
      permalink: null,
    });
  });

  it("reprise — compte déconnecté entre-temps : sortie propre, pas de requête bancale", async () => {
    await resetPublications();
    const { provider } = fakeProvider(["processing"]);
    const outcome = await publishToSocialAccount(deps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: null,
    });
    const publicationId = outcome.ok ? outcome.publicationId : "";

    // `on delete set null` : la trace survit au compte, sans token.
    await admin.from("social_publications").update({ social_account_id: null }).eq("id", publicationId);

    const resumed = fakeProvider(["ready"]);
    const second = await resumePublication(deps(resumed.provider), { workspaceId, publicationId });
    expect(second).toMatchObject({ ok: false, code: "token_unavailable" });
    expect(resumed.calls.publishedContainer).toBeNull();
  });

  // -------------------------------------------------------------------------
  // RLS
  // -------------------------------------------------------------------------

  it("RLS — le membre voit ses publications, un tiers est aveugle, personne n'écrit", async () => {
    await resetPublications();
    const { provider } = fakeProvider(["ready"]);
    await publishToSocialAccount(deps(provider), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ids.owner,
      mediaKind: "reel",
      mediaUrl: MEDIA_URL,
      caption: null,
    });

    const { data: seenByOwner } = await clients.owner
      .from("social_publications")
      .select("id, status")
      .eq("workspace_id", workspaceId);
    expect((seenByOwner ?? []).length).toBe(1);

    const { data: seenByOutsider } = await clients.outsider
      .from("social_publications")
      .select("id")
      .eq("workspace_id", workspaceId);
    expect(seenByOutsider ?? []).toHaveLength(0);

    // Aucune écriture n'est permise à `authenticated`, même sur son workspace.
    const insert = await clients.owner.from("social_publications").insert({
      workspace_id: workspaceId,
      social_account_id: accountId,
      platform: "instagram",
      provider_account_id: IG_ACCOUNT_ID,
      media_kind: "image",
      media_url: "https://cdn.example.com/x.jpg",
    });
    expect(insert.error).not.toBeNull();

    const update = await clients.owner
      .from("social_publications")
      .update({ status: "published" })
      .eq("workspace_id", workspaceId);
    expect(update.error).not.toBeNull();

    const remove = await clients.owner
      .from("social_publications")
      .delete()
      .eq("workspace_id", workspaceId);
    expect(remove.error).not.toBeNull();
  });

  it("cascade — supprimer le workspace supprime ses publications", async () => {
    const { data: ws } = await clients.owner.rpc("create_workspace", { p_name: "C84b Jetable" });
    const disposableId = (ws as { id: string }).id;
    await admin.from("social_publications").insert({
      workspace_id: disposableId,
      platform: "instagram",
      provider_account_id: IG_ACCOUNT_ID,
      media_kind: "image",
      media_url: "https://cdn.example.com/x.jpg",
      status: "failed",
    });

    await admin.from("workspaces").delete().eq("id", disposableId);
    const { count } = await admin
      .from("social_publications")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", disposableId);
    expect(count).toBe(0);
  });
});
