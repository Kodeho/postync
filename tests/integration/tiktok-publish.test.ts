/**
 * Publication TikTok — orchestration réelle contre la VRAIE base.
 *
 * Le publisher est le VRAI (`tiktokPublisher`) ; seul `fetch` est simulé.
 * Tout le reste est authentique : RLS, Vault, quota du plan, persistance,
 * reprise. C'est ce couplage qu'on veut éprouver, parce que TikTok ne se
 * comporte PAS comme Meta et que le moteur, lui, est commun.
 *
 * Le point dur, et la raison d'être de ce fichier :
 *
 *   chez Instagram, créer un conteneur ne publie rien. Chez TikTok en Direct
 *   Post, `video/init/` ENGAGE la publication — TikTok télécharge puis poste,
 *   sans second appel de notre part, et rien ne l'annule.
 *
 * Une publication qui échoue APRÈS cet appel doit donc rester `pending` avec
 * son `publish_id`, et être REPRISE — jamais relancée. Une relance créerait un
 * doublon sur le compte de l'utilisateur, et c'est irrattrapable.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { publishToSocialAccount, resumePublication, type PublishDeps } from "@/server/social/publish";
import { tiktokProvider } from "@/server/social/providers/tiktok";
import { TIKTOK_PUBLISH_SCOPE } from "@/server/social/providers/tiktok-publisher";
import { resetTikTokRateLimits } from "@/server/social/providers/tiktok-rate-limit";
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
const PASSWORD = `TT-${randomUUID()}`;
const OWNER = "postync-tiktok-owner@example.com";

const OPEN_ID = "_000TikTokOpenId000_";
const BASIC_SCOPE = "user.info.basic";
/** Servi par le domaine vérifié chez TikTok — cf. `media/delivery.ts`. */
const MEDIA_URL = "https://api.postync.app/storage/v1/object/sign/media/ws/a.mp4?token=sig";
const PUBLISH_ID = "v_pub_id.7248000000000000123";
const POST_ID = "7248000000000000123";

let admin: SupabaseClient;
let ownerId = "";
let ownerClient: SupabaseClient;
let workspaceId = "";
let accountId = "";

// ---------------------------------------------------------------------------
// Simulation de TikTok — par ENDPOINT, pas par rang d'appel
// ---------------------------------------------------------------------------

type Scenario = {
  /** Réponse de `creator_info/query`. */
  creator?: Response;
  /** Réponse de `video/init/`. */
  init?: Response;
  /** Réponses successives de `status/fetch/`, la dernière étant répétée. */
  statuses?: Response[];
};

/**
 * Le moteur sonde le statut un nombre de fois qui dépend de l'horloge : une
 * séquence par rang d'appel serait fragile. On dispatche donc sur l'URL, ce
 * qui reflète aussi mieux la réalité.
 *
 * IMPORTANT — tout ce qui ne va PAS chez TikTok est relayé au vrai `fetch`.
 * Le client Supabase passe par le même `globalThis.fetch` : l'intercepter
 * sans issue de secours coupe la base, et toute la suite échoue alors sur un
 * « compte introuvable » qui n'a rien à voir avec ce qu'on teste.
 */
function mockTikTok(scenario: Scenario) {
  const corps: string[] = [];
  let statusIndex = 0;
  const vraiFetch = globalThis.fetch.bind(globalThis);

  const mock = vi.spyOn(globalThis, "fetch");
  mock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("open.tiktokapis.com")) {
      return vraiFetch(input as RequestInfo, init);
    }
    corps.push(String(init?.body ?? ""));

    if (url.endsWith("/creator_info/query/")) {
      return (scenario.creator ?? creatorInfo()).clone();
    }
    if (url.endsWith("/video/init/")) {
      return (scenario.init ?? json({ data: { publish_id: PUBLISH_ID } })).clone();
    }
    if (url.endsWith("/status/fetch/")) {
      const liste = scenario.statuses ?? [json({ data: { status: "PUBLISH_COMPLETE" } })];
      const reponse = liste[Math.min(statusIndex, liste.length - 1)];
      statusIndex += 1;
      return reponse.clone();
    }
    throw new Error(`appel TikTok inattendu : ${url}`);
  });

  return {
    /** Corps envoyé au n-ième appel, analysé. */
    corpsDe: (index: number) => JSON.parse(corps[index] || "{}"),
    appelsVers: (fragment: string) =>
      mock.mock.calls.filter(([u]) => String(u).includes(fragment)).length,
    corps,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function creatorInfo(overrides: Record<string, unknown> = {}) {
  return json({
    data: {
      creator_username: "kodeho",
      creator_nickname: "Kodeho",
      privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      comment_disabled: false,
      duet_disabled: false,
      stitch_disabled: false,
      max_video_post_duration_sec: 600,
      ...overrides,
    },
  });
}

/** `now` qui avance vite : la boucle d'attente se termine sans attendre. */
function fastClock(): () => number {
  let value = Date.now();
  return () => {
    value += 20_000;
    return value;
  };
}

function deps(quota = 100): PublishDeps {
  return {
    db: admin,
    getProvider: (platform) => (platform === "tiktok" ? tiktokProvider : null),
    getMonthlyQuota: async () => quota,
    sleep: async () => undefined,
    now: fastClock(),
  };
}

function requete(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    socialAccountId: accountId,
    requestedBy: ownerId,
    mediaKind: "reel" as const,
    mediaUrl: MEDIA_URL,
    caption: "Bonjour TikTok",
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

async function reset(scopes: string[] = [BASIC_SCOPE, TIKTOK_PUBLISH_SCOPE]) {
  await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  await admin.from("social_accounts").update({ scopes, status: "active" }).eq("id", accountId);
}

describe.skipIf(!CONFIGURED)("TikTok — publication (orchestration réelle)", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    const { data, error } = await admin.auth.admin.createUser({
      email: OWNER,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "TikTok owner" },
    });
    if (error) throw error;
    ownerId = data.user.id;

    ownerClient = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NO_SESSION,
    );
    const { error: signInError } = await ownerClient.auth.signInWithPassword({
      email: OWNER,
      password: PASSWORD,
    });
    if (signInError) throw signInError;

    const { data: ws, error: e1 } = await ownerClient.rpc("create_workspace", {
      p_name: "TikTok WS",
    });
    if (e1) throw e1;
    workspaceId = (ws as { id: string }).id;

    const accessTokenId = await vaultStore(admin, "act.secret-du-compte", "tiktok/access");
    const { data: account, error: e2 } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "tiktok",
        provider_account_id: OPEN_ID,
        display_name: "kodeho",
        access_token_id: accessTokenId,
        scopes: [BASIC_SCOPE, TIKTOK_PUBLISH_SCOPE],
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
    // Le limiteur est un état de MODULE : sans remise à zéro, le 7e scénario
    // se heurterait au plafond de 6 `video/init/` par minute.
    resetTikTokRateLimits();
    delete process.env.TIKTOK_CLIENT_AUDITED;
    await reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Chaîne complète
  // -------------------------------------------------------------------------

  it("publie de bout en bout et enregistre l'identifiant PUBLIC du post", async () => {
    process.env.TIKTOK_CLIENT_AUDITED = "true";
    const tiktok = mockTikTok({
      statuses: [
        json({ data: { status: "PROCESSING_DOWNLOAD", downloaded_bytes: 1024 } }),
        new Response(
          `{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[${POST_ID}]}}`,
        ),
      ],
    });

    const outcome = await publishToSocialAccount(deps(), requete());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe("published");

    const row = await ligne(outcome.publicationId);
    // Le `publish_id` est conservé comme conteneur : c'est lui qui permet la
    // reprise, et c'est la seule référence connue avant la fin du traitement.
    expect(row.container_id).toBe(PUBLISH_ID);
    // L'identifiant public est relevé SUR LE TEXTE : un int64 passé par
    // `JSON.parse` perdrait ses derniers chiffres et le lien serait mort.
    expect(row.provider_media_id).toBe(POST_ID);
    expect(row.permalink).toBe(`https://www.tiktok.com/@kodeho/video/${POST_ID}`);
    expect(row.status).toBe("published");

    // Le média a été TIRÉ par TikTok : aucun octet n'a transité par POSTYNC.
    const init = tiktok.corps.find((c) => c.includes("PULL_FROM_URL"));
    expect(init).toBeDefined();
    expect(JSON.parse(init!).source_info).toEqual({
      source: "PULL_FROM_URL",
      video_url: MEDIA_URL,
    });
  }, 30_000);

  it("client NON audité : SELF_ONLY imposé, et la ligne reste honnête", async () => {
    // Aucun identifiant public n'existe pour un contenu privé : la ligne
    // conserve le `publish_id` et n'affiche AUCUN permalien. Fabriquer un lien
    // ici donnerait à l'utilisateur une adresse qui ne mène nulle part.
    const tiktok = mockTikTok({ statuses: [json({ data: { status: "PUBLISH_COMPLETE" } })] });

    const outcome = await publishToSocialAccount(deps(), requete());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const envoye = tiktok.corps.find((c) => c.includes("privacy_level"));
    expect(JSON.parse(envoye!).post_info.privacy_level).toBe("SELF_ONLY");

    const row = await ligne(outcome.publicationId);
    expect(row.provider_media_id).toBe(PUBLISH_ID);
    expect(row.permalink).toBeNull();
    // Aucun appel `creator_info` n'a été dépensé pour un permalien impossible.
    expect(tiktok.appelsVers("/creator_info/query/")).toBe(1);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Le verrou de mise en production
  // -------------------------------------------------------------------------

  it("hôte de média non vérifié : refus AVANT tout appel, la ligne porte le motif", async () => {
    // C'est l'état réel tant que `api.postync.app` n'est pas actif : les URL
    // signées portent l'hôte Supabase, que TikTok ne peut pas vérifier.
    const tiktok = mockTikTok({});

    const outcome = await publishToSocialAccount(
      deps(),
      requete({ mediaUrl: "https://abcdefgh.supabase.co/storage/v1/object/sign/media/a.mp4?t=s" }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.publicationId).not.toBeNull();

    // AUCUN appel n'est parti : ni créneau consommé, ni publication engagée.
    expect(tiktok.appelsVers("open.tiktokapis.com")).toBe(0);

    const row = await ligne(outcome.publicationId!);
    expect(row.status).toBe("failed");
    // Le motif exact est enregistré : sans lui, le diagnostic serait à refaire.
    expect(row.status_detail).toBe("media_host_unverified");
    expect(row.container_id).toBeNull();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Reprise — jamais de seconde publication
  // -------------------------------------------------------------------------

  it("traitement encore en cours : la ligne reste reprenable avec son publish_id", async () => {
    const tiktok = mockTikTok({ statuses: [json({ data: { status: "PROCESSING_DOWNLOAD" } })] });

    const outcome = await publishToSocialAccount(deps(), requete());
    expect(outcome).toMatchObject({ ok: true, status: "pending" });
    if (!outcome.ok) return;

    const row = await ligne(outcome.publicationId);
    expect(row.status).toBe("pending");
    expect(row.container_id).toBe(PUBLISH_ID);
    expect(tiktok.appelsVers("/video/init/")).toBe(1);
  }, 30_000);

  it("la reprise interroge le publish_id existant et ne RELANCE JAMAIS video/init", async () => {
    // Une seconde initialisation posterait la vidéo une deuxième fois. C'est
    // l'accident que toute cette architecture existe pour rendre impossible.
    const premier = mockTikTok({ statuses: [json({ data: { status: "PROCESSING_UPLOAD" } })] });
    const outcome = await publishToSocialAccount(deps(), requete());
    expect(outcome).toMatchObject({ ok: true, status: "pending" });
    if (!outcome.ok) return;
    expect(premier.appelsVers("/video/init/")).toBe(1);
    vi.restoreAllMocks();
    resetTikTokRateLimits();

    const reprise = mockTikTok({
      statuses: [
        new Response(
          `{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[${POST_ID}]}}`,
        ),
      ],
    });
    const suite = await resumePublication(deps(), {
      workspaceId,
      publicationId: outcome.publicationId,
    });

    expect(suite).toMatchObject({ ok: true, status: "published" });
    // LE point : aucune seconde initialisation. Le média n'est pas réenvoyé,
    // et la vidéo n'est pas postée deux fois.
    expect(reprise.appelsVers("/video/init/")).toBe(0);
    // `creator_info` est en revanche interrogé une fois, et une seule : le
    // post est public, donc le permalien est constructible, et le nom
    // d'utilisateur en est la pièce manquante.
    expect(reprise.appelsVers("/creator_info/query/")).toBe(1);

    const row = await ligne(outcome.publicationId);
    expect(row.provider_media_id).toBe(POST_ID);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Échecs
  // -------------------------------------------------------------------------

  it("échec de téléchargement TikTok : la ligne est marquée, pas oubliée", async () => {
    mockTikTok({
      statuses: [json({ data: { status: "FAILED", fail_reason: "video_pull_failed" } })],
    });

    const outcome = await publishToSocialAccount(deps(), requete());
    expect(outcome).toMatchObject({ ok: false, code: "container_failed" });
    if (outcome.ok) return;

    const row = await ligne(outcome.publicationId!);
    expect(row.status).toBe("failed");
    expect(row.status_detail).toBe("container_failed");
  }, 30_000);

  it("jeton refusé par TikTok : le compte cesse d'afficher « Connecté »", async () => {
    // Sans cela, une publication programmée échouerait chaque nuit pendant que
    // l'interface affirmerait que tout va bien.
    mockTikTok({ init: json({ error: { code: "access_token_invalid" } }, 401) });

    const outcome = await publishToSocialAccount(deps(), requete());
    expect(outcome).toMatchObject({ ok: false, code: "provider_error" });

    const { data: account } = await admin
      .from("social_accounts")
      .select("status, status_detail")
      .eq("id", accountId)
      .single();
    expect((account as { status: string }).status).toBe("revoked");
  }, 30_000);

  it("client non audité refusé par TikTok : compte INTACT, publication en échec", async () => {
    // `unaudited_client_can_only_post_to_private_accounts` ne dit rien sur
    // l'autorisation du compte. Le déclasser enverrait l'utilisateur
    // reconnecter un compte parfaitement valide.
    await reset();
    mockTikTok({
      init: json({ error: { code: "unaudited_client_can_only_post_to_private_accounts" } }, 403),
    });

    const outcome = await publishToSocialAccount(deps(), requete());
    expect(outcome).toMatchObject({ ok: false, code: "provider_error" });
    if (outcome.ok) return;

    const row = await ligne(outcome.publicationId!);
    expect(row.status_detail).toBe("unaudited_client");

    const { data: account } = await admin
      .from("social_accounts")
      .select("status")
      .eq("id", accountId)
      .single();
    expect((account as { status: string }).status).toBe("active");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Contrôles du moteur, appliqués à TikTok
  // -------------------------------------------------------------------------

  it("compte sans video.publish : reconnexion demandée, aucun appel distant", async () => {
    // Un compte connecté avant l'ajout du scope ne le porte pas. Tenter
    // l'appel donnerait `scope_not_authorized` et une ligne en échec pour
    // rien.
    await reset([BASIC_SCOPE]);
    const tiktok = mockTikTok({});

    const outcome = await publishToSocialAccount(deps(), requete());
    expect(outcome).toEqual({ ok: false, code: "missing_scope", publicationId: null });
    expect(tiktok.appelsVers("open.tiktokapis.com")).toBe(0);
  }, 30_000);

  it("TikTok ne publie pas d'image : refusé avant toute écriture", async () => {
    const tiktok = mockTikTok({});
    const outcome = await publishToSocialAccount(deps(), requete({ mediaKind: "image" }));
    expect(outcome).toEqual({ ok: false, code: "unsupported_media", publicationId: null });
    expect(tiktok.appelsVers("open.tiktokapis.com")).toBe(0);
  }, 30_000);

  it("quota du plan épuisé : rien n'est envoyé à TikTok", async () => {
    const tiktok = mockTikTok({});
    const outcome = await publishToSocialAccount(deps(0), requete());
    expect(outcome).toEqual({ ok: false, code: "quota_exceeded", publicationId: null });
    expect(tiktok.appelsVers("open.tiktokapis.com")).toBe(0);
  }, 30_000);

  it("le compte d'un AUTRE workspace reste inatteignable", async () => {
    const { data: ws } = await ownerClient.rpc("create_workspace", { p_name: "TikTok autre WS" });
    const autre = (ws as { id: string }).id;
    const tiktok = mockTikTok({});

    const outcome = await publishToSocialAccount(deps(), requete({ workspaceId: autre }));
    expect(outcome).toEqual({ ok: false, code: "account_not_found", publicationId: null });
    expect(tiktok.appelsVers("open.tiktokapis.com")).toBe(0);
  }, 30_000);
});
