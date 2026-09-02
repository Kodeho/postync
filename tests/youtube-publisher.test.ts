/**
 * Publication YouTube — Data API v3, `videos.insert` en upload résumable.
 * `fetch` simulé, aucun appel réseau.
 *
 * Ce que ces tests protègent, et pourquoi :
 *
 *   - YouTube est le SEUL réseau où POSTYNC pousse les octets. Le transfert
 *     est donc fractionné, et la position de reprise est toujours DEMANDÉE à
 *     Google, jamais mémorisée localement. Plusieurs tests vérifient
 *     précisément cela : après une interruption, on repart de l'octet que
 *     Google indique, pas de zéro ni d'un compteur maison ;
 *
 *   - une session résumable ne crée qu'UNE vidéo. Si `createContainer` était
 *     rappelée sur une publication qui a déjà sa session, il y aurait deux
 *     vidéos. Le test correspondant vérifie que reprendre n'ouvre jamais de
 *     seconde session ;
 *
 *   - `privacyStatus` et `selfDeclaredMadeForKids` sont ceux que
 *     l'utilisateur a choisis, transmis sans réécriture. YouTube rabat
 *     lui-même la visibilité sur `private` tant que le projet n'est pas
 *     audité — c'est sa décision, pas la nôtre ;
 *
 *   - l'identifiant de vidéo reste une CHAÎNE. Un identifiant YouTube contient
 *     lettres, tirets et soulignés : toute conversion le détruirait.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHUNK_SIZE,
  YOUTUBE_MIN_TRANSFER_BUDGET_MS,
  YOUTUBE_TITLE_MAX_LENGTH,
  YOUTUBE_UPLOAD_SCOPE,
  sessionOffset,
  totalFromMedia,
  youtubePublisher,
} from "@/server/social/providers/youtube-publisher";
import { SocialPublishError } from "@/server/social/providers/types";

const TOKEN = "ya29.google-access-token";
const CHANNEL = "UC86PZJH-k5RXPFzk_-7M5LQ";
const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=XYZ";
const MEDIA = "https://api.postync.app/storage/v1/object/sign/media/ws/a.mp4?token=sig";
const VIDEO_ID = "dQw4w9WgXcQ";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function mockFetchSequence(...responses: Response[]) {
  const mock = vi.spyOn(globalThis, "fetch");
  mock.mockImplementation(() => {
    throw new Error("appel fetch inattendu : la séquence simulée est épuisée");
  });
  for (const response of responses) mock.mockResolvedValueOnce(response);
  return mock;
}

/** Réponse d'ouverture de session : 200 + en-tête `Location`. */
const initiationOk = () => new Response(null, { status: 200, headers: { location: SESSION } });

/** Tranche de média renvoyée par le stockage. */
const tranche = (taille: number) =>
  new Response(new Uint8Array(taille), { status: 206, headers: { "content-length": String(taille) } });

/** `HEAD` sur le média : seule la taille compte. */
const tailleMedia = (taille: number) =>
  new Response(null, { status: 200, headers: { "content-length": String(taille) } });

/**
 * Simulateur ENDURANT d'une session résumable : il répond indéfiniment et tient
 * la position comme le ferait Google. Indispensable pour éprouver une boucle
 * qui s'arrête sur le temps et non sur un nombre d'appels — une séquence figée
 * s'épuiserait avant l'échéance et masquerait ce qu'on veut mesurer.
 */
function mockYouTubeEndurant(total: number) {
  let recu = 0;
  const mock = vi.spyOn(globalThis, "fetch");
  mock.mockImplementation(async (input, init) => {
    const methode = init?.method ?? "GET";
    if (methode === "HEAD") return tailleMedia(total);

    const plage = (init?.headers as Record<string, string> | undefined)?.["content-range"];
    if (plage?.startsWith("bytes */")) {
      // Interrogation de position.
      return recu === 0
        ? new Response(null, { status: 308 })
        : new Response(null, { status: 308, headers: { range: `bytes=0-${recu - 1}` } });
    }
    if (plage) {
      // Envoi d'un morceau : on avance la position.
      const bornes = /bytes (\d+)-(\d+)\//.exec(plage);
      if (bornes) recu = Number(bornes[2]) + 1;
      return recu >= total
        ? json({ id: VIDEO_ID }, 200)
        : new Response(null, { status: 308 });
    }
    // Lecture d'une tranche du média.
    const demande = (init?.headers as Record<string, string> | undefined)?.range;
    const bornes = /bytes=(\d+)-(\d+)/.exec(demande ?? "");
    const taille = bornes ? Number(bornes[2]) - Number(bornes[1]) + 1 : CHUNK_SIZE;
    void input;
    return tranche(taille);
  });
  return mock;
}

const base = {
  accessToken: TOKEN,
  providerAccountId: CHANNEL,
  mediaKind: "reel" as const,
  mediaUrl: MEDIA,
  caption: "Description de la vidéo",
  title: "Mon titre",
  byteSize: 1000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("capacités déclarées", () => {
  it("exige le scope d'écriture MINIMAL et rien de plus", () => {
    // `youtube`, `youtube.force-ssl` et `youtubepartner` autorisent aussi
    // `videos.insert`, mais ouvrent bien davantage. On ne prend que le
    // strict nécessaire.
    expect(youtubePublisher.requiredScopes).toEqual([
      "https://www.googleapis.com/auth/youtube.upload",
    ]);
    expect(YOUTUBE_UPLOAD_SCOPE).toBe("https://www.googleapis.com/auth/youtube.upload");
  });

  it("ne publie que de la vidéo, et sait reprendre un transfert", () => {
    expect(youtubePublisher.supportedMediaKinds).toEqual(["reel"]);
    // C'est ce qui distingue YouTube des trois autres : lui seul pousse les
    // octets, donc lui seul déclare `resumeTransfer`.
    expect(typeof youtubePublisher.resumeTransfer).toBe("function");
  });

  it("n'expose PAS de quota distant : Google ne publie aucun compteur", () => {
    expect(youtubePublisher.remoteQuota).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Titre
// ---------------------------------------------------------------------------

describe("titre", () => {
  it("refuse un titre absent sans toucher au réseau", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      youtubePublisher.createContainer({ ...base, title: null }),
    ).rejects.toMatchObject({ code: "title_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuse un titre fait d'espaces — ce n'est pas un titre", async () => {
    await expect(
      youtubePublisher.createContainer({ ...base, title: "   " }),
    ).rejects.toMatchObject({ code: "title_required" });
  });

  it("refuse au-delà de 100 caractères, accepte 100 pile", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      youtubePublisher.createContainer({ ...base, title: "a".repeat(101) }),
    ).rejects.toMatchObject({ code: "title_too_long" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    mockFetchSequence(initiationOk());
    await expect(
      youtubePublisher.createContainer({
        ...base,
        title: "a".repeat(YOUTUBE_TITLE_MAX_LENGTH),
      }),
    ).resolves.toBe(SESSION);
  });
});

// ---------------------------------------------------------------------------
// Ouverture de session
// ---------------------------------------------------------------------------

describe("ouverture de la session résumable", () => {
  it("annonce la taille et le type AVANT le premier octet", async () => {
    const fetchMock = mockFetchSequence(initiationOk());
    const session = await youtubePublisher.createContainer(base);

    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe("https://www.googleapis.com/upload/youtube/v3/videos");
    expect(u.searchParams.get("uploadType")).toBe("resumable");
    expect(u.searchParams.get("part")).toBe("snippet,status");

    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Sans ces deux en-têtes, Google refuse d'ouvrir la session.
    expect(headers["x-upload-content-length"]).toBe("1000");
    expect(headers["x-upload-content-type"]).toBe("video/*");

    // L'URI de session EST le conteneur : c'est elle qui rend la reprise
    // possible, et elle doit ressortir telle quelle.
    expect(session).toBe(SESSION);
  });

  it("la légende devient la DESCRIPTION, le titre reste le titre", async () => {
    const fetchMock = mockFetchSequence(initiationOk());
    await youtubePublisher.createContainer(base);
    const corps = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(corps.snippet.title).toBe("Mon titre");
    expect(corps.snippet.description).toBe("Description de la vidéo");
  });

  it.each(["private", "unlisted", "public"] as const)(
    "transmet la visibilité choisie sans la réécrire : %s",
    async (choix) => {
      // La Required Minimum Functionality impose que l'utilisateur puisse
      // choisir entre les trois. La version précédente de ce test verrouillait
      // `private` en s'appuyant sur une lecture ERRONÉE de la documentation :
      // Google écrit « restricted to private viewing mode », pas « rejected ».
      // C'est YouTube qui rabat la visibilité tant que le projet n'est pas
      // audité — ce n'est pas à nous de supprimer le choix.
      const fetchMock = mockFetchSequence(initiationOk());
      await youtubePublisher.createContainer({ ...base, privacyLevel: choix });
      const corps = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(corps.status.privacyStatus).toBe(choix);
    },
  );

  it("sans visibilité transmise, retombe sur la valeur la moins exposante", async () => {
    // Chemin non nominal : `publish.ts` refuse déjà une publication YouTube
    // sans visibilité. Le repli existe pour qu'un appel interne oublieux ne
    // publie jamais quelque chose de plus visible que voulu.
    const fetchMock = mockFetchSequence(initiationOk());
    await youtubePublisher.createContainer({ ...base, privacyLevel: null });
    const corps = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(corps.status.privacyStatus).toBe("private");
  });

  it.each([true, false])("transmet la déclaration Made for Kids : %s", async (declare) => {
    // Developer Policies III.J. Cette valeur engage l'utilisateur : elle doit
    // arriver chez Google exactement telle qu'il l'a déclarée.
    const fetchMock = mockFetchSequence(initiationOk());
    await youtubePublisher.createContainer({ ...base, madeForKids: declare });
    const corps = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(corps.status.selfDeclaredMadeForKids).toBe(declare);
  });

  it("taille inconnue : elle est MESURÉE plutôt que d'abandonner", async () => {
    // La médiathèque connaît la taille et la transmet. Le chemin historique
    // « URL saisie à la main » ne mesure rien : sans ce repli, YouTube y
    // serait définitivement impossible. Un `HEAD` suffit, sans transférer un
    // seul octet.
    const fetchMock = mockFetchSequence(tailleMedia(777), initiationOk());
    await expect(
      youtubePublisher.createContainer({ ...base, byteSize: null }),
    ).resolves.toBe(SESSION);

    expect(fetchMock.mock.calls[0][1]?.method).toBe("HEAD");
    const headers = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(headers["x-upload-content-length"]).toBe("777");
  });

  it("taille introuvable même après mesure : on refuse, on n'invente pas", async () => {
    mockFetchSequence(new Response(null, { status: 404 }));
    await expect(
      youtubePublisher.createContainer({ ...base, byteSize: null }),
    ).rejects.toMatchObject({ code: "media_size_unknown" });
  });

  it("refuse une image", async () => {
    await expect(
      youtubePublisher.createContainer({ ...base, mediaKind: "image" }),
    ).rejects.toMatchObject({ code: "unsupported_media" });
  });

  it("Location absent : échec net, rien n'a été envoyé", async () => {
    mockFetchSequence(new Response(null, { status: 200 }));
    await expect(youtubePublisher.createContainer(base)).rejects.toMatchObject({
      code: "container_missing",
    });
  });
});

// ---------------------------------------------------------------------------
// Position de reprise
// ---------------------------------------------------------------------------

describe("position de reprise", () => {
  it("lit l'octet suivant à partir de l'en-tête Range", async () => {
    // `Range: bytes=0-999999` désigne le DERNIER octet reçu. Repartir de
    // 999999 renverrait cet octet une seconde fois et décalerait tout.
    mockFetchSequence(new Response(null, { status: 308, headers: { range: "bytes=0-999999" } }));
    await expect(sessionOffset(SESSION, TOKEN, 5_000_000)).resolves.toBe(1_000_000);
  });

  it("308 sans Range : aucun octet reçu", async () => {
    mockFetchSequence(new Response(null, { status: 308 }));
    await expect(sessionOffset(SESSION, TOKEN, 1000)).resolves.toBe(0);
  });

  it("200 signifie terminé, pas « octet zéro »", async () => {
    // Confondre les deux relancerait un transfert déjà complet.
    mockFetchSequence(json({ id: VIDEO_ID }));
    await expect(sessionOffset(SESSION, TOKEN, 1000)).resolves.toBeNull();
  });

  it("interroge avec la forme documentée", async () => {
    const fetchMock = mockFetchSequence(new Response(null, { status: 308 }));
    await sessionOffset(SESSION, TOKEN, 4242);
    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe("PUT");
    const headers = init?.headers as Record<string, string>;
    expect(headers["content-range"]).toBe("bytes */4242");
    expect(headers["content-length"]).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// Transfert fractionné
// ---------------------------------------------------------------------------

describe("transfert fractionné", () => {
  it("envoie les morceaux successifs avec le bon Content-Range", async () => {
    const taille = CHUNK_SIZE + 1000;
    const fetchMock = mockFetchSequence(
      tailleMedia(taille),
      new Response(null, { status: 308 }), // position : 0
      tranche(CHUNK_SIZE),
      new Response(null, { status: 308, headers: { range: `bytes=0-${CHUNK_SIZE - 1}` } }),
      new Response(null, { status: 308, headers: { range: `bytes=0-${CHUNK_SIZE - 1}` } }),
      tranche(1000),
      json({ id: VIDEO_ID }),
    );

    await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: Date.now() + 600_000,
    });

    const envois = fetchMock.mock.calls.filter(
      ([, init]) => (init?.headers as Record<string, string>)?.["content-range"]?.startsWith("bytes 0-")
        || (init?.headers as Record<string, string>)?.["content-range"]?.startsWith(`bytes ${CHUNK_SIZE}-`),
    );
    const ranges = envois.map(([, i]) => (i?.headers as Record<string, string>)["content-range"]);
    expect(ranges[0]).toBe(`bytes 0-${CHUNK_SIZE - 1}/${taille}`);
    expect(ranges[1]).toBe(`bytes ${CHUNK_SIZE}-${taille - 1}/${taille}`);
  });

  it("REPREND à l'octet indiqué par Google, jamais depuis zéro", async () => {
    // Le cœur du sujet : après une coupure, la moitié déjà transmise ne doit
    // pas repartir. C'est Google qui dit où il en est.
    const taille = CHUNK_SIZE * 2;
    const dejaRecu = CHUNK_SIZE;
    const fetchMock = mockFetchSequence(
      tailleMedia(taille),
      new Response(null, { status: 308, headers: { range: `bytes=0-${dejaRecu - 1}` } }),
      tranche(CHUNK_SIZE),
      json({ id: VIDEO_ID }),
    );

    await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: Date.now() + 600_000,
    });

    // La tranche demandée au stockage commence à l'octet suivant, pas à 0.
    const lecture = fetchMock.mock.calls.find(
      ([, init]) => (init?.headers as Record<string, string>)?.range?.startsWith("bytes="),
    );
    expect((lecture?.[1]?.headers as Record<string, string>).range).toBe(
      `bytes=${dejaRecu}-${taille - 1}`,
    );
  });

  it("REFUSE une fenêtre trop courte au lieu de rendre la main en silence", async () => {
    // Ce test affirmait l'inverse, et c'est ce qui a laissé passer la panne en
    // production : une fenêtre sous le seuil sortait sans rien faire, sans
    // erreur ni trace, et la publication tournait en reprise perpétuelle.
    // Un budget trop court est une erreur de câblage — elle doit se voir.
    const fetchMock = mockFetchSequence(tailleMedia(CHUNK_SIZE * 4));
    await expect(
      youtubePublisher.resumeTransfer!({
        accessToken: TOKEN,
        containerId: SESSION,
        mediaUrl: MEDIA,
        deadline: Date.now() + YOUTUBE_MIN_TRANSFER_BUDGET_MS - 1,
      }),
    ).rejects.toMatchObject({ code: "transfer_window_too_small" });
    // Le refus est immédiat : pas même la mesure de taille n'a été tentée.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("s'interrompt à l'échéance après avoir réellement transféré", async () => {
    // Au-dessus du seuil : le transfert démarre et progresse, puis l'échéance
    // tombe. La session reste valide et Google conserve les octets reçus —
    // c'est ce qui rend l'abandon sûr et dispense d'une réserve dimensionnée
    // pour un morceau entier.
    const total = CHUNK_SIZE * 500; // trop gros pour finir dans la fenêtre
    const fetchMock = mockYouTubeEndurant(total);

    const debut = Date.now();
    const resultat = await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: debut + YOUTUBE_MIN_TRANSFER_BUDGET_MS + 500,
    });

    // Il a poussé, il n'a pas fini, et il a rendu la main de lui-même.
    expect(resultat.pushedBytes).toBeGreaterThan(0);
    expect(resultat.pushedBytes).toBeLessThan(total);
    expect(Date.now() - debut).toBeLessThan(YOUTUBE_MIN_TRANSFER_BUDGET_MS + 3_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
  });

  it("s'arrête dès que la session est complète", async () => {
    const fetchMock = mockFetchSequence(
      tailleMedia(1000),
      json({ id: VIDEO_ID }), // déjà terminé : offset null
    );
    await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: Date.now() + 600_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("média illisible : signalé, pas ignoré", async () => {
    mockFetchSequence(new Response(null, { status: 200 })); // pas de content-length
    await expect(
      youtubePublisher.resumeTransfer!({
        accessToken: TOKEN,
        containerId: SESSION,
        mediaUrl: MEDIA,
        deadline: Date.now() + 600_000,
      }),
    ).rejects.toMatchObject({ code: "media_unreadable" });
  });
});

// ---------------------------------------------------------------------------
// Anti-double-envoi
// ---------------------------------------------------------------------------

describe("aucun double envoi possible", () => {
  it("reprendre n'ouvre JAMAIS de seconde session", async () => {
    // Une deuxième session créerait une deuxième vidéo. `resumeTransfer` ne
    // doit donc jamais toucher au point d'ouverture.
    const fetchMock = mockFetchSequence(
      tailleMedia(1000),
      new Response(null, { status: 308 }),
      tranche(1000),
      json({ id: VIDEO_ID }),
    );

    await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: Date.now() + 600_000,
    });

    const ouvertures = fetchMock.mock.calls.filter(
      ([url, init]) =>
        init?.method === "POST" && String(url).includes("uploadType=resumable"),
    );
    expect(ouvertures).toHaveLength(0);
  });

  it("toutes les écritures visent la MÊME session", async () => {
    const fetchMock = mockFetchSequence(
      tailleMedia(1000),
      new Response(null, { status: 308 }),
      tranche(1000),
      json({ id: VIDEO_ID }),
    );
    await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: Date.now() + 600_000,
    });
    const versSession = fetchMock.mock.calls.filter(([u]) => String(u) === SESSION);
    expect(versSession.length).toBeGreaterThan(0);
    for (const [, init] of versSession) expect(init?.method).toBe("PUT");
  });
});

// ---------------------------------------------------------------------------
// Statut et identifiant
// ---------------------------------------------------------------------------

describe("statut de la session", () => {
  it("308 = il manque des octets", async () => {
    mockFetchSequence(new Response(null, { status: 308 }));
    await expect(
      youtubePublisher.containerStatus({ accessToken: TOKEN, containerId: SESSION }),
    ).resolves.toBe("processing");
  });

  it("200 = tout est arrivé", async () => {
    mockFetchSequence(json({ id: VIDEO_ID }));
    await expect(
      youtubePublisher.containerStatus({ accessToken: TOKEN, containerId: SESSION }),
    ).resolves.toBe("ready");
  });

  it("404 ou 410 = session périmée, on le DIT plutôt que de boucler", async () => {
    for (const statut of [404, 410]) {
      vi.restoreAllMocks();
      mockFetchSequence(new Response(null, { status: statut }));
      await expect(
        youtubePublisher.containerStatus({ accessToken: TOKEN, containerId: SESSION }),
      ).resolves.toBe("expired");
    }
  });
});

describe("identifiant de la vidéo", () => {
  it("relit la session terminée et conserve l'id EN CHAÎNE", async () => {
    mockFetchSequence(json({ id: VIDEO_ID }));
    const { providerMediaId } = await youtubePublisher.publishContainer({
      accessToken: TOKEN,
      providerAccountId: CHANNEL,
      containerId: SESSION,
    });
    // Un identifiant YouTube contient tirets et soulignés : toute conversion
    // numérique le détruirait.
    expect(providerMediaId).toBe(VIDEO_ID);
    expect(typeof providerMediaId).toBe("string");
  });

  it("id absent : signalé, jamais inventé", async () => {
    mockFetchSequence(json({}));
    await expect(
      youtubePublisher.publishContainer({
        accessToken: TOKEN,
        providerAccountId: CHANNEL,
        containerId: SESSION,
      }),
    ).rejects.toMatchObject({ code: "media_id_missing" });
  });

  it("construit le permalien sans aucun appel distant", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      youtubePublisher.fetchPermalink!({ accessToken: TOKEN, providerMediaId: VIDEO_ID }),
    ).resolves.toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Erreurs Google
// ---------------------------------------------------------------------------

describe("erreurs de la plateforme", () => {
  const cas: [string, number, string][] = [
    ["invalidTitle", 400, "invalid_title"],
    ["invalidDescription", 400, "invalid_description"],
    ["mediaBodyRequired", 400, "media_missing"],
    ["forbiddenPrivacySetting", 403, "privacy_rejected"],
    ["uploadLimitExceeded", 400, "remote_quota_exceeded"],
    ["quotaExceeded", 403, "remote_quota_exceeded"],
    ["rateLimitExceeded", 403, "rate_limited"],
    ["youtubeSignupRequired", 401, "no_channel"],
    ["authError", 401, "auth_invalid"],
    ["insufficientPermissions", 403, "missing_scope"],
  ];

  for (const [reason, statut, attendu] of cas) {
    it(`${reason} → ${attendu}`, async () => {
      mockFetchSequence(
        json({ error: { code: statut, errors: [{ reason, message: "détail" }] } }, statut),
      );
      await expect(youtubePublisher.createContainer(base)).rejects.toMatchObject({
        code: attendu,
      });
    });
  }

  it("raison inconnue : on retombe sur le statut HTTP", async () => {
    mockFetchSequence(json({ error: { errors: [{ reason: "somethingNew" }] } }, 500));
    await expect(youtubePublisher.createContainer(base)).rejects.toMatchObject({
      code: "http_500",
    });
  });

  it("ne laisse fuir NI le jeton NI le message brut de Google", async () => {
    mockFetchSequence(
      json(
        {
          error: {
            errors: [
              { reason: "invalidTitle", message: `le jeton ${TOKEN} et la chaîne ${CHANNEL}` },
            ],
          },
        },
        400,
      ),
    );
    const erreur = await youtubePublisher.createContainer(base).catch((e: unknown) => e);
    const texte = `${(erreur as Error).message} ${(erreur as SocialPublishError).code}`;
    expect(texte).not.toContain(TOKEN);
    expect(texte).not.toContain(CHANNEL);
    // La raison documentée, elle, est conservée : c'est le diagnostic.
    expect(texte).toContain("invalidTitle");
  });
});

describe("mesure du média", () => {
  it("lit la taille par un HEAD, sans transférer d'octet", async () => {
    const fetchMock = mockFetchSequence(tailleMedia(123456));
    await expect(totalFromMedia(MEDIA)).resolves.toBe(123456);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("HEAD");
  });

  it("réponse illisible : zéro plutôt qu'une valeur inventée", async () => {
    mockFetchSequence(new Response(null, { status: 404 }));
    await expect(totalFromMedia(MEDIA)).resolves.toBe(0);
  });
});
