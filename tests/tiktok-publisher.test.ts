/**
 * Publication TikTok — conformité à la Content Posting API (Direct Post,
 * PULL_FROM_URL). `fetch` simulé, aucun appel réseau.
 *
 * Ce que ces tests protègent en particulier, et pourquoi :
 *
 *   - `video/init/` ENGAGE la publication et rien ne l'annule. Tous les
 *     contrôles locaux doivent donc échouer AVANT lui : plusieurs tests
 *     vérifient non pas le message d'erreur, mais le fait qu'AUCUN appel
 *     réseau n'a eu lieu. C'est la seule assertion qui a du sens ici ;
 *
 *   - un client non audité ne peut publier qu'en `SELF_ONLY`. Si cette règle
 *     cède, POSTYNC rendra publiques des vidéos que TikTok aurait refusées —
 *     ou pire, les rendra publiques alors que l'utilisateur croyait l'inverse ;
 *
 *   - l'hôte du média doit appartenir au domaine dont nous avons prouvé la
 *     propriété. Un test vérifie qu'`evilpostync.app` ne passe PAS pour un
 *     sous-domaine de `postync.app` : la comparaison par suffixe nu est
 *     l'erreur classique, et elle enverrait nos URL signées n'importe où ;
 *
 *   - aucune erreur brute de TikTok ne remonte : seulement un code court.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetTikTokRateLimits } from "@/server/social/providers/tiktok-rate-limit";
import {
  extractPublicPostId,
  normalizeTikTokStatus,
  resolvePrivacyLevel,
  tiktokPublisher,
  type TikTokPrivacyLevel,
} from "@/server/social/providers/tiktok-publisher";
import { SocialPublishError } from "@/server/social/providers/types";

const TOKEN = "act.tiktok-access-token";
const OPEN_ID = "_000TikTokOpenId000_";
const MEDIA = "https://api.postync.app/storage/v1/object/sign/media/ws/asset.mp4?token=sig";

const CREATOR_INFO = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const VIDEO_INIT = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mockFetchSequence(...responses: Response[]) {
  const mock = vi.spyOn(globalThis, "fetch");
  mock.mockImplementation(() => {
    throw new Error("appel fetch inattendu : la séquence simulée est épuisée");
  });
  for (const response of responses) {
    mock.mockResolvedValueOnce(response);
  }
  return mock;
}

/** Réponse `creator_info` type : compte public, aucun réglage restrictif. */
function creatorInfo(overrides: Record<string, unknown> = {}) {
  return json({
    data: {
      creator_username: "kodeho",
      creator_nickname: "Kodeho",
      privacy_level_options: [
        "PUBLIC_TO_EVERYONE",
        "MUTUAL_FOLLOW_FRIENDS",
        "FOLLOWER_OF_CREATOR",
        "SELF_ONLY",
      ],
      comment_disabled: false,
      duet_disabled: false,
      stitch_disabled: false,
      max_video_post_duration_sec: 600,
      ...overrides,
    },
  });
}

/** Corps JSON réellement envoyé au n-ième appel. */
function bodyOf(mock: ReturnType<typeof mockFetchSequence>, index: number) {
  return JSON.parse(String(mock.mock.calls[index][1]?.body));
}

const base = {
  accessToken: TOKEN,
  providerAccountId: OPEN_ID,
  mediaKind: "reel" as const,
  mediaUrl: MEDIA,
  caption: "Bonjour",
};

beforeEach(() => {
  resetTikTokRateLimits();
  delete process.env.TIKTOK_CLIENT_AUDITED;
  delete process.env.TIKTOK_VERIFIED_MEDIA_DOMAIN;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("capacités déclarées", () => {
  it("exige video.publish et ne publie que de la vidéo", () => {
    expect(tiktokPublisher.requiredScopes).toEqual(["video.publish"]);
    // Cette API ne poste pas d'image isolée : l'annoncer serait un mensonge
    // que l'utilisateur découvrirait au moment de publier.
    expect(tiktokPublisher.supportedMediaKinds).toEqual(["reel"]);
  });

  it("n'expose PAS de quota distant : TikTok n'en publie aucun", () => {
    // Rendre `null` en permanence donnerait l'illusion d'une mesure.
    expect(tiktokPublisher.remoteQuota).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Garde-fous locaux — aucun appel réseau ne doit partir
// ---------------------------------------------------------------------------

describe("refus AVANT tout appel distant", () => {
  it("refuse une image sans toucher au réseau", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      tiktokPublisher.createContainer({ ...base, mediaKind: "image" }),
    ).rejects.toMatchObject({ code: "unsupported_media" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuse un titre de plus de 2200 runes UTF-16 sans toucher au réseau", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      tiktokPublisher.createContainer({ ...base, caption: "a".repeat(2201) }),
    ).rejects.toMatchObject({ code: "caption_too_long" });
    expect(fetchMock).not.toHaveBeenCalled();

    // 2200 pile passe : la borne est inclusive côté TikTok.
    mockFetchSequence(creatorInfo(), json({ data: { publish_id: "pub-1" } }));
    await expect(
      tiktokPublisher.createContainer({ ...base, caption: "a".repeat(2200) }),
    ).resolves.toBe("pub-1");
  });

  it("REFUSE l'hôte Supabase par défaut — c'est le verrou de mise en production", async () => {
    // Tant que `api.postync.app` n'est pas actif, les URL signées portent
    // l'hôte du projet Supabase, que nous ne possédons pas et que TikTok ne
    // peut donc pas vérifier. Laisser partir l'appel ferait consommer un
    // créneau pour un refus certain — et surtout, ferait croire que la chaîne
    // fonctionne.
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      tiktokPublisher.createContainer({
        ...base,
        mediaUrl: "https://abcdefgh.supabase.co/storage/v1/object/sign/media/x.mp4?token=s",
      }),
    ).rejects.toMatchObject({ code: "media_host_unverified" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuse le HTTP en clair", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      tiktokPublisher.createContainer({ ...base, mediaUrl: "http://api.postync.app/x.mp4" }),
    ).rejects.toMatchObject({ code: "media_url_not_https" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuse une URL portant des identifiants", async () => {
    await expect(
      tiktokPublisher.createContainer({
        ...base,
        mediaUrl: "https://user:pass@api.postync.app/x.mp4",
      }),
    ).rejects.toMatchObject({ code: "media_url_embedded_credentials" });
  });

  it("un domaine qui RESSEMBLE au nôtre n'est pas le nôtre", async () => {
    // `evilpostync.app` se termine par « postync.app ». Une comparaison par
    // suffixe nu le laisserait passer, et nos URL signées partiraient chez un
    // tiers. Le point de séparation n'est pas un détail.
    await expect(
      tiktokPublisher.createContainer({ ...base, mediaUrl: "https://evilpostync.app/x.mp4" }),
    ).rejects.toMatchObject({ code: "media_host_unverified" });
  });

  it("accepte le domaine vérifié et ses sous-domaines", async () => {
    // TikTok : « Domain verification covers all paths under that domain and
    // its subdomains ». `postync.app` couvre donc `api.postync.app`.
    for (const hote of ["postync.app", "api.postync.app", "media.cdn.postync.app"]) {
      resetTikTokRateLimits();
      mockFetchSequence(creatorInfo(), json({ data: { publish_id: `pub-${hote}` } }));
      await expect(
        tiktokPublisher.createContainer({ ...base, mediaUrl: `https://${hote}/a.mp4` }),
      ).resolves.toBe(`pub-${hote}`);
      vi.restoreAllMocks();
    }
  });

  it("le domaine vérifié est configurable sans toucher au code", async () => {
    process.env.TIKTOK_VERIFIED_MEDIA_DOMAIN = "exemple.test";
    mockFetchSequence(creatorInfo(), json({ data: { publish_id: "pub-env" } }));
    await expect(
      tiktokPublisher.createContainer({ ...base, mediaUrl: "https://cdn.exemple.test/a.mp4" }),
    ).resolves.toBe("pub-env");
  });
});

// ---------------------------------------------------------------------------
// creator_info + video/init
// ---------------------------------------------------------------------------

describe("séquence de publication", () => {
  it("interroge creator_info PUIS video/init, en Direct Post PULL_FROM_URL", async () => {
    const fetchMock = mockFetchSequence(creatorInfo(), json({ data: { publish_id: "pub-42" } }));

    const publishId = await tiktokPublisher.createContainer({ ...base, durationSeconds: 30 });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 1) creator_info — obligatoire avant toute publication.
    const [urlInfo, initInfo] = fetchMock.mock.calls[0];
    expect(String(urlInfo)).toBe(CREATOR_INFO);
    expect(initInfo?.method).toBe("POST");
    const headersInfo = initInfo?.headers as Record<string, string>;
    expect(headersInfo.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headersInfo["content-type"]).toBe("application/json; charset=UTF-8");

    // 2) video/init — le média est TIRÉ par TikTok, jamais poussé par nous.
    const [urlInit] = fetchMock.mock.calls[1];
    expect(String(urlInit)).toBe(VIDEO_INIT);
    const corps = bodyOf(fetchMock, 1);
    expect(corps.source_info).toEqual({ source: "PULL_FROM_URL", video_url: MEDIA });
    expect(corps.post_info.title).toBe("Bonjour");
    // Aucun octet ne transite par POSTYNC : pas de taille, pas de découpage.
    expect(corps.source_info.video_size).toBeUndefined();
    expect(corps.source_info.chunk_size).toBeUndefined();

    expect(publishId).toBe("pub-42");
  });

  it("un titre absent devient une chaîne vide, jamais « null »", async () => {
    const fetchMock = mockFetchSequence(creatorInfo(), json({ data: { publish_id: "p" } }));
    await tiktokPublisher.createContainer({ ...base, caption: null });
    expect(bodyOf(fetchMock, 1).post_info.title).toBe("");
  });

  it("respecte les réglages du créateur sans jamais les contredire", async () => {
    const fetchMock = mockFetchSequence(
      creatorInfo({ comment_disabled: true, duet_disabled: true, stitch_disabled: false }),
      json({ data: { publish_id: "p" } }),
    );
    await tiktokPublisher.createContainer(base);

    const post = bodyOf(fetchMock, 1).post_info;
    // Le créateur a fermé commentaires et duos : on ne les rouvre pas.
    expect(post.disable_comment).toBe(true);
    expect(post.disable_duet).toBe(true);
    // Il a laissé la couture ouverte : on ne la ferme pas non plus.
    expect(post.disable_stitch).toBe(false);
  });

  it("publish_id absent : rien à reprendre, et surtout rien à réessayer", async () => {
    mockFetchSequence(creatorInfo(), json({ data: {} }));
    await expect(tiktokPublisher.createContainer(base)).rejects.toMatchObject({
      code: "container_missing",
    });
  });
});

// ---------------------------------------------------------------------------
// Confidentialité
// ---------------------------------------------------------------------------

describe("privacy_level", () => {
  it("client NON audité : SELF_ONLY imposé, même si l'appelant demande le public", async () => {
    // C'est la règle TikTok, pas une préférence : demander PUBLIC ne donne pas
    // une publication publique, cela donne un refus.
    const fetchMock = mockFetchSequence(creatorInfo(), json({ data: { publish_id: "p" } }));
    await tiktokPublisher.createContainer({ ...base, privacyLevel: "PUBLIC_TO_EVERYONE" });
    expect(bodyOf(fetchMock, 1).post_info.privacy_level).toBe("SELF_ONLY");
  });

  it("client audité : public par défaut, et le choix de l'appelant est suivi", async () => {
    process.env.TIKTOK_CLIENT_AUDITED = "true";

    const m1 = mockFetchSequence(creatorInfo(), json({ data: { publish_id: "p" } }));
    await tiktokPublisher.createContainer(base);
    expect(bodyOf(m1, 1).post_info.privacy_level).toBe("PUBLIC_TO_EVERYONE");
    vi.restoreAllMocks();
    resetTikTokRateLimits();

    const m2 = mockFetchSequence(creatorInfo(), json({ data: { publish_id: "p" } }));
    await tiktokPublisher.createContainer({ ...base, privacyLevel: "MUTUAL_FOLLOW_FRIENDS" });
    expect(bodyOf(m2, 1).post_info.privacy_level).toBe("MUTUAL_FOLLOW_FRIENDS");
  });

  it("seul « true » exact active l'audit — pas « TRUE » approximatif ni « 1 »", () => {
    // Un drapeau d'environnement mal orthographié ne doit JAMAIS ouvrir la
    // publication publique par accident.
    for (const valeur of ["1", "yes", "oui", "false", ""]) {
      process.env.TIKTOK_CLIENT_AUDITED = valeur;
      expect(resolvePrivacyLevel(["SELF_ONLY"], false, "PUBLIC_TO_EVERYONE")).toBe("SELF_ONLY");
    }
  });

  it("niveau indisponible : on refuse, on ne se rabat pas en silence", () => {
    // Se rabattre changerait la visibilité du contenu à l'insu de
    // l'utilisateur — exactement ce qu'un outil de publication ne doit pas
    // faire.
    expect(() => resolvePrivacyLevel(["PUBLIC_TO_EVERYONE"], false)).toThrowError(
      SocialPublishError,
    );
    expect(() => resolvePrivacyLevel(["SELF_ONLY"], true, "PUBLIC_TO_EVERYONE")).toThrowError(
      /privacy_level_unavailable|indisponible/,
    );
  });

  it("compte privé : SELF_ONLY absent des options fait échouer AVANT video/init", async () => {
    const fetchMock = mockFetchSequence(creatorInfo({ privacy_level_options: ["FOLLOWER_OF_CREATOR"] }));
    await expect(tiktokPublisher.createContainer(base)).rejects.toMatchObject({
      code: "privacy_level_unavailable",
    });
    // creator_info seulement : la publication n'a jamais été engagée.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignore une option inconnue renvoyée par TikTok", () => {
    // Une valeur hors énumération ne doit pas devenir un niveau utilisable.
    const options = ["SELF_ONLY", "SOMETHING_NEW"] as unknown as TikTokPrivacyLevel[];
    expect(resolvePrivacyLevel(options, false)).toBe("SELF_ONLY");
  });
});

// ---------------------------------------------------------------------------
// Durée
// ---------------------------------------------------------------------------

describe("durée maximale", () => {
  it("applique le plafond DU CRÉATEUR, pas une constante", async () => {
    // Un compte plafonné à 60 s ne doit pas se voir proposer 90 s au motif
    // que l'API en autorise 600.
    const fetchMock = mockFetchSequence(creatorInfo({ max_video_post_duration_sec: 60 }));
    await expect(
      tiktokPublisher.createContainer({ ...base, durationSeconds: 90 }),
    ).rejects.toMatchObject({ code: "media_too_long" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("laisse passer une durée conforme", async () => {
    mockFetchSequence(
      creatorInfo({ max_video_post_duration_sec: 60 }),
      json({ data: { publish_id: "p" } }),
    );
    await expect(
      tiktokPublisher.createContainer({ ...base, durationSeconds: 60 }),
    ).resolves.toBe("p");
  });

  it("durée inconnue : on ne bloque pas sur une mesure qu'on n'a pas", async () => {
    mockFetchSequence(creatorInfo(), json({ data: { publish_id: "p" } }));
    await expect(
      tiktokPublisher.createContainer({ ...base, durationSeconds: null }),
    ).resolves.toBe("p");
  });

  it("plafond créateur absent : repli sur les 10 minutes documentées", async () => {
    const fetchMock = mockFetchSequence(creatorInfo({ max_video_post_duration_sec: undefined }));
    await expect(
      tiktokPublisher.createContainer({ ...base, durationSeconds: 601 }),
    ).rejects.toMatchObject({ code: "media_too_long" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Erreurs TikTok
// ---------------------------------------------------------------------------

describe("erreurs de la plateforme", () => {
  const cas: [string, number, string][] = [
    ["unaudited_client_can_only_post_to_private_accounts", 403, "unaudited_client"],
    ["url_ownership_unverified", 403, "media_host_unverified"],
    ["privacy_level_option_mismatch", 403, "privacy_level_rejected"],
    ["spam_risk_too_many_posts", 403, "remote_quota_exceeded"],
    ["reached_active_user_cap", 403, "remote_quota_exceeded"],
    ["spam_risk_user_banned_from_posting", 403, "account_banned"],
    ["access_token_invalid", 401, "auth_invalid"],
    ["scope_not_authorized", 401, "missing_scope"],
    ["rate_limit_exceeded", 429, "rate_limited"],
    ["invalid_param", 400, "invalid_param"],
  ];

  for (const [codeTikTok, statut, codeCourt] of cas) {
    it(`${codeTikTok} → ${codeCourt}`, async () => {
      mockFetchSequence(
        creatorInfo(),
        json({ error: { code: codeTikTok, message: "détail", log_id: "L1" } }, statut),
      );
      await expect(tiktokPublisher.createContainer(base)).rejects.toMatchObject({
        code: codeCourt,
      });
    });
  }

  it("lit l'erreur DANS LE CORPS même en HTTP 200 — piège TikTok déjà rencontré", async () => {
    // Constaté le 2026-08-27 sur le serveur d'autorisation : HTTP 200 avec un
    // corps d'erreur. Se fier à `response.ok` laisserait passer la panne.
    mockFetchSequence(creatorInfo(), json({ error: { code: "invalid_param" } }, 200));
    await expect(tiktokPublisher.createContainer(base)).rejects.toMatchObject({
      code: "invalid_param",
    });
  });

  it("`ok` n'est pas une erreur", async () => {
    mockFetchSequence(
      json({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } }),
      json({ data: { publish_id: "p" }, error: { code: "ok" } }),
    );
    await expect(tiktokPublisher.createContainer(base)).resolves.toBe("p");
  });

  it("ne laisse fuir NI le jeton NI le message brut de TikTok", async () => {
    mockFetchSequence(
      creatorInfo(),
      json(
        {
          error: {
            code: "invalid_param",
            message: `le compte ${OPEN_ID} et le jeton ${TOKEN} sont refusés`,
            log_id: "L2",
          },
        },
        400,
      ),
    );
    const erreur = await tiktokPublisher.createContainer(base).catch((e: unknown) => e);
    const texte = `${(erreur as Error).message} ${(erreur as SocialPublishError).code}`;
    expect(texte).not.toContain(TOKEN);
    expect(texte).not.toContain(OPEN_ID);
    // Le code documenté, lui, est conservé : c'est le diagnostic.
    expect(texte).toContain("invalid_param");
  });

  it("un corps illisible ne masque pas un échec HTTP", async () => {
    mockFetchSequence(creatorInfo(), new Response("<html>502</html>", { status: 502 }));
    await expect(tiktokPublisher.createContainer(base)).rejects.toMatchObject({
      code: "http_502",
    });
  });

  it("HTTP 200 sans data : signalé, pas ignoré", async () => {
    mockFetchSequence(json({}));
    await expect(tiktokPublisher.createContainer(base)).rejects.toMatchObject({
      code: "empty_response",
    });
  });
});

// ---------------------------------------------------------------------------
// Statuts
// ---------------------------------------------------------------------------

describe("suivi de statut", () => {
  it("traduit chaque statut officiel", () => {
    expect(normalizeTikTokStatus("PUBLISH_COMPLETE")).toBe("ready");
    expect(normalizeTikTokStatus("FAILED")).toBe("failed");
    expect(normalizeTikTokStatus("PROCESSING_UPLOAD")).toBe("processing");
    expect(normalizeTikTokStatus("PROCESSING_DOWNLOAD")).toBe("processing");
    expect(normalizeTikTokStatus("SEND_TO_USER_INBOX")).toBe("processing");
    // Un statut inconnu n'est JAMAIS « prêt » : on ne publie pas au hasard.
    expect(normalizeTikTokStatus("QUELQUE_CHOSE_DE_NEUF")).toBe("processing");
    expect(normalizeTikTokStatus(undefined)).toBe("processing");
  });

  it("interroge status/fetch avec le publish_id", async () => {
    const fetchMock = mockFetchSequence(json({ data: { status: "PROCESSING_DOWNLOAD" } }));
    const statut = await tiktokPublisher.containerStatus({
      accessToken: TOKEN,
      containerId: "pub-7",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(STATUS);
    expect(bodyOf(fetchMock, 0)).toEqual({ publish_id: "pub-7" });
    expect(statut).toBe("processing");
  });

  it("journalise fail_reason sans exposer la moindre donnée de compte", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchSequence(json({ data: { status: "FAILED", fail_reason: "video_pull_failed" } }));

    const statut = await tiktokPublisher.containerStatus({
      accessToken: TOKEN,
      containerId: "pub-8",
    });

    expect(statut).toBe("failed");
    const ligne = String(log.mock.calls[0][0]);
    expect(ligne).toContain("video_pull_failed");
    expect(ligne).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Finalisation
// ---------------------------------------------------------------------------

describe("récupération de l'identifiant du post", () => {
  it("relit le statut et retient l'identifiant PUBLIC quand il existe", async () => {
    // TikTok ne communique cet identifiant qu'une fois le post public ET
    // validé par la modération : c'est le seul moment où on peut le lire.
    //
    // Le corps est écrit À LA MAIN, et non via `JSON.stringify` : un
    // identifiant TikTok est un int64 (~7,2 × 10^18), très au-delà de
    // `Number.MAX_SAFE_INTEGER`. Le fabriquer en JavaScript le tronquerait
    // AVANT même d'atteindre le code testé, et le test ne prouverait rien.
    const fetchMock = mockFetchSequence(
      new Response(
        '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7248000000000000123]}}',
      ),
    );
    const { providerMediaId } = await tiktokPublisher.publishContainer({
      accessToken: TOKEN,
      providerAccountId: OPEN_ID,
      containerId: "pub-9",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(STATUS);
    expect(providerMediaId).toBe("7248000000000000123");
  });

  it("ne perd AUCUN chiffre d'un identifiant int64", () => {
    // Le défaut que ce test verrouille est silencieux et grave : passé par
    // `JSON.parse`, 7248000000000000123 devient 7248000000000000000, et le
    // permalien publié pointe vers une vidéo qui n'existe pas.
    const brut =
      '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7248000000000000123]}}';
    expect(extractPublicPostId(brut)).toBe("7248000000000000123");
    // La démonstration du danger, pour que personne ne « simplifie » plus tard.
    expect(String(JSON.parse(brut).data.publicaly_available_post_id[0])).not.toBe(
      "7248000000000000123",
    );
  });

  it("accepte aussi la forme chaîne, et une liste vide", () => {
    expect(extractPublicPostId('{"data":{"publicaly_available_post_id":["7248000000000000123"]}}')).toBe(
      "7248000000000000123",
    );
    expect(extractPublicPostId('{"data":{"publicaly_available_post_id":[]}}')).toBeNull();
    expect(extractPublicPostId('{"data":{"status":"PUBLISH_COMPLETE"}}')).toBeNull();
  });

  it("SELF_ONLY : aucun identifiant public, on garde le publish_id", async () => {
    // C'est le cas NOMINAL tant que le client n'est pas audité. Inventer un
    // identifiant public serait pire que ne rien avoir.
    mockFetchSequence(json({ data: { status: "PUBLISH_COMPLETE" } }));
    const { providerMediaId } = await tiktokPublisher.publishContainer({
      accessToken: TOKEN,
      providerAccountId: OPEN_ID,
      containerId: "pub-10",
    });
    expect(providerMediaId).toBe("pub-10");
  });

  it("statut illisible : la publication reste tracée par son publish_id", async () => {
    // Le contenu est en ligne chez TikTok. Échouer ici perdrait la trace
    // d'une publication qui, elle, existe bel et bien.
    mockFetchSequence(json({ error: { code: "internal_error" } }, 500));
    const { providerMediaId } = await tiktokPublisher.publishContainer({
      accessToken: TOKEN,
      providerAccountId: OPEN_ID,
      containerId: "pub-11",
    });
    expect(providerMediaId).toBe("pub-11");
  });
});

describe("permalien", () => {
  it("aucun appel réseau quand l'identifiant n'est pas un post public", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      tiktokPublisher.fetchPermalink!({ accessToken: TOKEN, providerMediaId: "pub-12" }),
    ).resolves.toBeNull();
    // Client non audité : ce chemin ne coûte donc jamais un créneau.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("construit l'URL publique à partir du nom d'utilisateur", async () => {
    mockFetchSequence(creatorInfo());
    await expect(
      tiktokPublisher.fetchPermalink!({ accessToken: TOKEN, providerMediaId: "7248000000000000123" }),
    ).resolves.toBe("https://www.tiktok.com/@kodeho/video/7248000000000000123");
  });

  it("reste best effort : un échec ne remet pas en cause la publication", async () => {
    mockFetchSequence(json({ error: { code: "access_token_invalid" } }, 401));
    await expect(
      tiktokPublisher.fetchPermalink!({ accessToken: TOKEN, providerMediaId: "7248000000000000123" }),
    ).resolves.toBeNull();
  });
});
