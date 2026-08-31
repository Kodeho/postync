/**
 * Publication YouTube — orchestration réelle contre la VRAIE base.
 *
 * Le publisher est le VRAI (`youtubePublisher`) ; seul `fetch` est simulé.
 * RLS, Vault, quota, persistance et reprise sont authentiques.
 *
 * CE QUE CE FICHIER EXISTE POUR PROUVER. YouTube est le seul réseau où
 * POSTYNC pousse les octets, et où « en cours » signifie « il en manque »
 * plutôt que « la plateforme travaille ». Deux invariants en découlent, et
 * aucun test unitaire ne peut les établir seul :
 *
 *   1. l'URI de session est PERSISTÉE dès son ouverture, même si le transfert
 *      n'est pas terminé — sans quoi la reprise serait impossible et le
 *      prochain essai créerait une seconde vidéo ;
 *   2. la reprise ne rouvre JAMAIS de session : elle pousse les octets
 *      manquants dans celle qui existe déjà.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { publishToSocialAccount, resumePublication, type PublishDeps } from "@/server/social/publish";
import { youtubeProvider } from "@/server/social/providers/youtube";
import { YOUTUBE_UPLOAD_SCOPE } from "@/server/social/providers/youtube-publisher";
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
const PASSWORD = `YT-${randomUUID()}`;
const OWNER = "postync-youtube-owner@example.com";

const CHANNEL = "UC86PZJH-k5RXPFzk_-7M5LQ";
const READONLY = "https://www.googleapis.com/auth/youtube.readonly";
const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION1";
const VIDEO_ID = "dQw4w9WgXcQ";
const MEDIA_URL = "https://cdn.example.test/video.mp4";
const TAILLE = 4096;

let admin: SupabaseClient;
let ownerId = "";
let ownerClient: SupabaseClient;
let workspaceId = "";
let accountId = "";

// ---------------------------------------------------------------------------
// Simulation de Google — par forme de requête, jamais par rang d'appel
// ---------------------------------------------------------------------------

type Scenario = {
  /** Octets déjà reçus par Google au moment où le scénario démarre. */
  dejaRecu?: number;
  /** La session accepte-t-elle de se terminer ? */
  termine?: boolean;
  /** Réponse imposée à l'ouverture de session. */
  initiation?: Response;
};

function mockGoogle(scenario: Scenario = {}) {
  const vraiFetch = globalThis.fetch.bind(globalThis);
  let recu = scenario.dejaRecu ?? 0;
  const appels = { ouvertures: 0, ecritures: 0, lecturesMedia: 0, sondes: 0 };

  const mock = vi.spyOn(globalThis, "fetch");
  mock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    // Supabase passe par le même `fetch` : sans issue de secours, la base
    // tombe et toute la suite échoue pour une raison sans rapport.
    if (!url.includes("googleapis.com") && !url.startsWith(MEDIA_URL)) {
      return vraiFetch(input as RequestInfo, init);
    }

    // Le média : HEAD pour la taille, GET Range pour une tranche.
    if (url.startsWith(MEDIA_URL)) {
      appels.lecturesMedia += 1;
      if (init?.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-length": String(TAILLE) } });
      }
      return new Response(new Uint8Array(TAILLE - recu), { status: 206 });
    }

    // Ouverture de session.
    if (init?.method === "POST") {
      appels.ouvertures += 1;
      return scenario.initiation
        ? scenario.initiation.clone()
        : new Response(null, { status: 200, headers: { location: SESSION } });
    }

    // Tout le reste est un PUT sur la session.
    const range = (init?.headers as Record<string, string>)?.["content-range"] ?? "";
    if (range.startsWith("bytes */")) {
      appels.sondes += 1;
      if (recu >= TAILLE && scenario.termine !== false) {
        return new Response(JSON.stringify({ id: VIDEO_ID }), { status: 200 });
      }
      return new Response(null, {
        status: 308,
        headers: recu > 0 ? { range: `bytes=0-${recu - 1}` } : {},
      });
    }

    appels.ecritures += 1;
    if (scenario.termine === false) {
      // Transfert volontairement inachevé : Google confirme la réception
      // partielle et en redemande.
      recu = Math.min(recu + 1, TAILLE - 1);
      return new Response(null, { status: 308, headers: { range: `bytes=0-${recu - 1}` } });
    }
    recu = TAILLE;
    return new Response(JSON.stringify({ id: VIDEO_ID }), { status: 200 });
  });

  return appels;
}

function deps(quota = 100, pollBudgetMs = 60_000, now?: () => number): PublishDeps {
  return {
    db: admin,
    getProvider: (platform) => (platform === "youtube" ? youtubeProvider : null),
    getMonthlyQuota: async () => quota,
    sleep: async () => undefined,
    pollBudgetMs,
    ...(now ? { now } : {}),
  };
}

/** `now` qui avance vite, comme dans les suites Meta et TikTok. */
function fastClock(): () => number {
  let value = Date.now();
  return () => {
    value += 20_000;
    return value;
  };
}

/**
 * Budget si court qu'aucun morceau ne peut être tenté : `resumeTransfer` rend
 * la main immédiatement. C'est la façon déterministe de reproduire un
 * transfert interrompu, sans dépendre d'un chronomètre.
 */
function depsSansTemps(): PublishDeps {
  return deps(100, 1);
}

function requete(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    socialAccountId: accountId,
    requestedBy: ownerId,
    mediaKind: "reel" as const,
    mediaUrl: MEDIA_URL,
    caption: "Description",
    title: "Mon titre YouTube",
    ...overrides,
  };
}

async function ligne(publicationId: string) {
  const { data } = await admin
    .from("social_publications")
    .select("status, status_detail, container_id, provider_media_id, permalink")
    .eq("id", publicationId)
    .single();
  return data as {
    status: string;
    status_detail: string | null;
    container_id: string | null;
    provider_media_id: string | null;
    permalink: string | null;
  };
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((u) => u.email === OWNER)) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

async function reset(scopes: string[] = [READONLY, YOUTUBE_UPLOAD_SCOPE]) {
  await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  await admin.from("social_accounts").update({ scopes, status: "active" }).eq("id", accountId);
}

describe.skipIf(!CONFIGURED)("YouTube — publication (orchestration réelle)", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    const { data, error } = await admin.auth.admin.createUser({
      email: OWNER,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "YouTube owner" },
    });
    if (error) throw error;
    ownerId = data.user.id;

    ownerClient = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NO_SESSION,
    );
    const { error: e0 } = await ownerClient.auth.signInWithPassword({
      email: OWNER,
      password: PASSWORD,
    });
    if (e0) throw e0;

    const { data: ws, error: e1 } = await ownerClient.rpc("create_workspace", {
      p_name: "YouTube WS",
    });
    if (e1) throw e1;
    workspaceId = (ws as { id: string }).id;

    const accessTokenId = await vaultStore(admin, "ya29.secret-du-compte", "youtube/access");
    const { data: account, error: e2 } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "youtube",
        provider_account_id: CHANNEL,
        display_name: "Ma chaîne",
        access_token_id: accessTokenId,
        scopes: [READONLY, YOUTUBE_UPLOAD_SCOPE],
        connected_by: ownerId,
      })
      .select("id")
      .single();
    if (e2) throw e2;
    accountId = (account as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  beforeEach(async () => {
    await reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Chaîne complète
  // -------------------------------------------------------------------------

  it("publie de bout en bout et enregistre l'id de vidéo et son permalien", async () => {
    mockGoogle();

    const outcome = await publishToSocialAccount(deps(), requete());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe("published");

    const row = await ligne(outcome.publicationId);
    // Le CONTENEUR est l'URI de session : c'est elle qui rend la reprise
    // possible, et elle doit être conservée telle quelle.
    expect(row.container_id).toBe(SESSION);
    // L'identifiant reste une chaîne, tirets et soulignés compris.
    expect(row.provider_media_id).toBe(VIDEO_ID);
    expect(row.permalink).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
    expect(row.status).toBe("published");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Interruption et reprise
  // -------------------------------------------------------------------------

  it("transfert inachevé : la session est PERSISTÉE, la ligne reste reprenable", async () => {
    // Sans cette persistance, la session serait perdue et la tentative
    // suivante créerait une deuxième vidéo.
    const appels = mockGoogle({ termine: false });

    const outcome = await publishToSocialAccount(depsSansTemps(), requete());
    expect(outcome).toMatchObject({ ok: true, status: "pending" });
    if (!outcome.ok) return;

    const row = await ligne(outcome.publicationId);
    expect(row.status).toBe("pending");
    // LE point : l'URI est enregistrée alors même que le transfert n'est pas
    // terminé. Sans elle, la reprise serait impossible.
    expect(row.container_id).toBe(SESSION);
    expect(appels.ouvertures).toBe(1);
  }, 30_000);

  it("la reprise pousse la SUITE et n'ouvre JAMAIS de seconde session", async () => {
    // L'invariant central : deux sessions signifieraient deux vidéos.
    const premier = mockGoogle({ termine: false });
    const outcome = await publishToSocialAccount(depsSansTemps(), requete());
    expect(outcome).toMatchObject({ ok: true, status: "pending" });
    if (!outcome.ok) return;
    expect(premier.ouvertures).toBe(1);
    vi.restoreAllMocks();

    const reprise = mockGoogle({ dejaRecu: 1024 });
    const suite = await resumePublication(deps(), {
      workspaceId,
      publicationId: outcome.publicationId,
    });

    expect(suite).toMatchObject({ ok: true, status: "published" });
    // AUCUNE ouverture pendant la reprise — deux sessions = deux vidéos.
    expect(reprise.ouvertures).toBe(0);
    // Mais des octets sont bien partis dans la session existante.
    expect(reprise.ecritures).toBeGreaterThan(0);

    const row = await ligne(outcome.publicationId);
    expect(row.container_id).toBe(SESSION);
    expect(row.provider_media_id).toBe(VIDEO_ID);
  }, 30_000);

  it("session périmée : la ligne échoue proprement au lieu de boucler", async () => {
    mockGoogle();
    const outcome = await publishToSocialAccount(deps(), requete());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    vi.restoreAllMocks();

    const vraiFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("googleapis.com")) return vraiFetch(input as RequestInfo, init);
      return new Response(null, { status: 410 });
    });

    await admin
      .from("social_publications")
      .update({ status: "pending" })
      .eq("id", outcome.publicationId);

    const suite = await resumePublication(deps(), {
      workspaceId,
      publicationId: outcome.publicationId,
    });
    expect(suite).toMatchObject({ ok: false, code: "container_expired" });
  }, 30_000);

  it("une horloge injectée ne fait pas diverger le budget de transfert", async () => {
    // RÉGRESSION VÉCUE. Le budget est compté avec `deps.now` ; le provider ne
    // peut comparer qu'à `Date.now()`. Tant que l'échéance était transmise
    // brute, une horloge accélérée les faisait diverger : la boucle tournait
    // des milliers de fois et le worker de test finissait par mourir.
    //
    // Le moteur convertit désormais le TEMPS RESTANT en échéance réelle. Ce
    // test rejoue exactement la configuration fautive : s'il se termine, la
    // divergence est fermée.
    mockGoogle();

    const outcome = await publishToSocialAccount(
      deps(100, 60_000, fastClock()),
      requete(),
    );

    expect(outcome).toMatchObject({ ok: true, status: "published" });
  }, 20_000);

  // -------------------------------------------------------------------------
  // Contrôles du moteur appliqués à YouTube
  // -------------------------------------------------------------------------

  it("compte sans youtube.upload : reconnexion demandée, aucun appel distant", async () => {
    await reset([READONLY]);
    const appels = mockGoogle();

    const outcome = await publishToSocialAccount(deps(), requete());
    expect(outcome).toEqual({ ok: false, code: "missing_scope", publicationId: null });
    expect(appels.ouvertures).toBe(0);
  }, 30_000);

  it("titre absent : la ligne échoue avec le motif exact", async () => {
    mockGoogle();
    const outcome = await publishToSocialAccount(deps(), requete({ title: null }));
    expect(outcome).toMatchObject({ ok: false, code: "provider_error" });
    if (outcome.ok) return;
    const row = await ligne(outcome.publicationId!);
    expect(row.status_detail).toBe("title_required");
  }, 30_000);

  it("YouTube ne publie pas d'image", async () => {
    const appels = mockGoogle();
    const outcome = await publishToSocialAccount(deps(), requete({ mediaKind: "image" }));
    expect(outcome).toEqual({ ok: false, code: "unsupported_media", publicationId: null });
    expect(appels.ouvertures).toBe(0);
  }, 30_000);

  it("quota du plan épuisé : rien n'est envoyé à Google", async () => {
    const appels = mockGoogle();
    const outcome = await publishToSocialAccount(deps(0), requete());
    expect(outcome).toEqual({ ok: false, code: "quota_exceeded", publicationId: null });
    expect(appels.ouvertures).toBe(0);
  }, 30_000);

  it("le compte d'un AUTRE workspace reste inatteignable", async () => {
    const { data: ws } = await ownerClient.rpc("create_workspace", { p_name: "YouTube autre WS" });
    const autre = (ws as { id: string }).id;
    const appels = mockGoogle();
    const outcome = await publishToSocialAccount(deps(), requete({ workspaceId: autre }));
    expect(outcome).toEqual({ ok: false, code: "account_not_found", publicationId: null });
    expect(appels.ouvertures).toBe(0);
  }, 30_000);
});
