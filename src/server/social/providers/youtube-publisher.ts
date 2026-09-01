import "server-only";

import {
  SocialPublishError,
  type ContainerStatus,
  type CreateContainerInput,
  type SocialPublisher,
} from "./types";

/**
 * Publication YouTube — Data API v3, `videos.insert` en upload RÉSUMABLE.
 *
 * Documentation officielle vérifiée le 2026-08-31 (developers.google.com/
 * youtube/v3 : docs/videos/insert, guides/using_resumable_upload_protocol,
 * determine_quota_cost, revision_history).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUI DIFFÈRE DES TROIS AUTRES RÉSEAUX — à lire avant de modifier
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Instagram reçoit un `video_url`, Facebook un en-tête `file_url`, TikTok un
 * `PULL_FROM_URL` : dans les trois cas la PLATEFORME va chercher le fichier,
 * et aucun octet ne traverse POSTYNC.
 *
 * YouTube n'offre aucun équivalent. `videos.insert` n'accepte pas d'URL
 * distante : c'est le client qui pousse les octets. Un fichier de 300 Mo ne
 * tient donc pas dans une seule invocation serverless, et c'est tout le sujet
 * de ce module.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * L'ARCHITECTURE : la session résumable EST le conteneur
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `createContainer` ouvre une session résumable et rend son URI. Cette URI
 * est enregistrée dans `social_publications.container_id`, exactement comme
 * un identifiant de conteneur Instagram ou un `publish_id` TikTok. Elle
 * survit donc à la fin de l'invocation.
 *
 * À partir de là, le moteur existant fait le reste sans rien connaître de
 * YouTube :
 *
 *   · `resumeTransfer` pousse des octets jusqu'à son échéance, puis rend la
 *     main. Ce qui reste attendra le réveil suivant ;
 *   · `containerStatus` interroge la session — `308` signifie « il manque des
 *     octets », `200/201` signifie « tout est arrivé » ;
 *   · `publishContainer` relit la session terminée pour en extraire le
 *     `videoId`, que Google renvoie dans le corps de la réponse finale.
 *
 * LA REPRISE EST SÛRE PARCE QU'ELLE N'EST PAS DEVINÉE. Avant chaque envoi on
 * demande à Google où il en est (`Content-Range: bytes STAR/TOTAL`), et on
 * repart de l'octet qu'il indique. Aucune position n'est mémorisée de notre
 * côté : la session distante est la seule source de vérité. Une interruption
 * au milieu d'un morceau ne fait donc perdre que ce morceau.
 *
 * D'OÙ L'IMPOSSIBILITÉ DU DOUBLE ENVOI. Une session résumable ne crée qu'UNE
 * vidéo, quel que soit le nombre de reprises. Comme l'URI est persistée dès
 * son ouverture et que le moteur ne rappelle jamais `createContainer` sur une
 * ligne qui a déjà un conteneur, il ne peut pas exister deux vidéos pour une
 * publication.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CONFIDENTIALITÉ : `private`, imposé côté serveur
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Google, historique des révisions : « All videos uploaded via the
 * videos.insert endpoint from unverified API projects created after 28 July
 * 2020 will be restricted to private viewing mode. »
 *
 * Tant que le projet n'a pas passé l'audit, demander autre chose que `private`
 * ne rend pas la vidéo publique : cela produit un refus, ou une vidéo
 * verrouillée en privé sans que l'utilisateur comprenne pourquoi. On impose
 * donc `private` ici, sans exposer le choix. Le retirer devra SUIVRE l'audit,
 * jamais l'anticiper.
 */

const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos";
const WATCH_URL = "https://www.youtube.com/watch?v=";

/** Écriture. Suffit à `videos.insert` — aucun scope plus large n'est requis. */
export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

/** Limites officielles du champ `snippet`. */
export const YOUTUBE_TITLE_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 5000;

/**
 * Taille d'un morceau. Google exige un multiple de 256 Ko pour tout envoi
 * partiel ; 8 Mo est un compromis courant entre nombre d'allers-retours et
 * quantité reperdue quand un morceau échoue.
 */
export const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Marge conservée pour rendre la main proprement.
 *
 * ELLE N'A PAS À COUVRIR UN MORCEAU ENTIER, et c'est le cœur du correctif.
 * `sessionOffset` demande la position réelle À GOOGLE avant chaque envoi :
 * un morceau interrompu en vol n'est donc pas une perte de données mais une
 * progression partielle, que la reprise suivante lit telle quelle. Il suffit
 * d'avoir le temps d'abandonner la requête et de revenir.
 *
 * La version précédente réservait 12 s — le temps supposé d'un morceau complet.
 * Aucun appelant n'accordant autant, la condition de garde était vraie dès la
 * première itération et AUCUN octet ne partait jamais, sans erreur ni trace.
 */
const TRANSFER_TAIL_MS = 1_500;

/**
 * Fenêtre minimale sous laquelle tenter un envoi n'a plus de sens : le temps
 * d'interroger la session et d'ouvrir la lecture du média.
 */
const MIN_TRANSFER_WINDOW_MS = 3_000;

/**
 * Budget minimal qu'un appelant DOIT accorder pour que `resumeTransfer` puisse
 * tenter quelque chose. Exporté pour que les appelants soient vérifiables :
 * c'est l'absence de cette confrontation qui a laissé passer la panne.
 */
export const YOUTUBE_MIN_TRANSFER_BUDGET_MS = MIN_TRANSFER_WINDOW_MS + TRANSFER_TAIL_MS;

/** Visibilité imposée tant que le projet n'est pas audité (voir en-tête). */
const PRIVACY_STATUS = "private";

type GoogleErrorPayload = {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    errors?: { reason?: string; message?: string }[];
  };
};

/**
 * Codes d'erreur documentés, ramenés à un code court et enregistrable.
 *
 * Ce sont des `reason` publiés par Google, pas des données utilisateur : les
 * conserver ne fuite rien. `message`, lui, est un texte libre qui peut citer
 * le titre ou la chaîne — il ne sort jamais d'ici.
 */
const CODES: Record<string, string> = {
  invalidTitle: "invalid_title",
  invalidDescription: "invalid_description",
  invalidCategoryId: "invalid_category",
  invalidVideoMetadata: "invalid_metadata",
  mediaBodyRequired: "media_missing",
  forbiddenPrivacySetting: "privacy_rejected",
  uploadLimitExceeded: "remote_quota_exceeded",
  quotaExceeded: "remote_quota_exceeded",
  rateLimitExceeded: "rate_limited",
  youtubeSignupRequired: "no_channel",
  forbidden: "forbidden",
  authError: "auth_invalid",
  insufficientPermissions: "missing_scope",
};

/** `reason` le plus précis d'une réponse Google — jamais le corps complet. */
async function googleFailure(response: Response, contexte: string): Promise<SocialPublishError> {
  let reason = "";
  try {
    const payload = (await response.json()) as GoogleErrorPayload;
    reason = payload.error?.errors?.[0]?.reason ?? payload.error?.status ?? "";
  } catch {
    reason = "";
  }
  const code = CODES[reason] ?? `http_${response.status}`;
  // Le détail porte le `reason` brut : `classifyFailure` s'en sert pour
  // distinguer un jeton mort d'une panne passagère.
  return new SocialPublishError(
    code,
    `youtube ${contexte}: HTTP ${response.status} ${reason}`.trim(),
  );
}

// ---------------------------------------------------------------------------
// Session résumable
// ---------------------------------------------------------------------------

/**
 * Position réelle du transfert, DEMANDÉE À GOOGLE.
 *
 * `null` signifie que la session est terminée — tous les octets sont arrivés.
 * Un nombre est le prochain octet attendu. On ne devine jamais cette valeur :
 * c'est ce qui rend la reprise fiable après n'importe quelle interruption.
 */
async function sessionOffset(
  sessionUri: string,
  accessToken: string,
  total: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const response = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-range": `bytes */${total}`,
      "content-length": "0",
    },
    signal,
  });

  if (response.status === 308) {
    const range = response.headers.get("range");
    if (!range) return 0; // Aucun octet reçu pour l'instant.
    const fin = /bytes=0-(\d+)/.exec(range);
    // `Range: bytes=0-N` désigne le DERNIER octet reçu : le suivant est N+1.
    return fin ? Number(fin[1]) + 1 : 0;
  }
  if (response.ok) {
    return null;
  }
  throw await googleFailure(response, "session status");
}

/**
 * Lit une tranche du média et la pousse. Renvoie `true` quand la session est
 * terminée après cet envoi.
 *
 * La tranche est demandée au stockage par un en-tête `Range` : on ne charge
 * jamais les 300 Mo en mémoire, seulement le morceau courant.
 */
async function pushChunk(
  sessionUri: string,
  accessToken: string,
  mediaUrl: string,
  debut: number,
  total: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const fin = Math.min(debut + CHUNK_SIZE, total) - 1;

  const media = await fetch(mediaUrl, { headers: { range: `bytes=${debut}-${fin}` }, signal });
  if (!media.ok && media.status !== 206) {
    throw new SocialPublishError("media_unreadable", `youtube media: HTTP ${media.status}`);
  }
  const bytes = new Uint8Array(await media.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new SocialPublishError("media_unreadable", "youtube media: tranche vide");
  }

  const response = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-length": String(bytes.byteLength),
      "content-range": `bytes ${debut}-${debut + bytes.byteLength - 1}/${total}`,
    },
    body: bytes,
    signal,
  });

  if (response.status === 308) return false;
  if (response.ok) return true;
  throw await googleFailure(response, "upload chunk");
}

/**
 * Signal d'abandon calé sur l'échéance, ou `undefined` si l'environnement ne
 * sait pas le fabriquer. Une requête ne doit jamais survivre à l'invocation
 * qui l'a lancée : ce qu'elle rendrait n'irait plus nulle part.
 */
function signalJusqua(deadline: number): AbortSignal | undefined {
  const restant = deadline - Date.now();
  if (restant <= 0) return undefined;
  return AbortSignal.timeout(restant);
}

/** Un abandon sur échéance n'est pas une panne : c'est la fin du temps imparti. */
function estAbandon(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

export const youtubePublisher: SocialPublisher = {
  requiredScopes: [YOUTUBE_UPLOAD_SCOPE],
  // `videos.insert` ne publie que de la vidéo. Une image passerait par un
  // autre produit (miniatures), hors sujet ici.
  supportedMediaKinds: ["reel"],

  /**
   * Ouvre la session résumable et pousse ce qui tient dans le temps imparti.
   *
   * Ce qui compte ici : l'URI est rendue MÊME si tous les octets ne sont pas
   * partis. Elle est alors persistée par le moteur, et la reprise devient
   * possible. Rendre une erreur à la place perdrait la session, et le prochain
   * essai créerait une seconde vidéo.
   */
  async createContainer(input: CreateContainerInput): Promise<string> {
    if (input.mediaKind !== "reel") {
      throw new SocialPublishError("unsupported_media");
    }
    const titre = (input.title ?? "").trim();
    if (titre.length === 0) {
      throw new SocialPublishError("title_required");
    }
    if (titre.length > YOUTUBE_TITLE_MAX_LENGTH) {
      throw new SocialPublishError("title_too_long");
    }
    if (input.caption && input.caption.length > DESCRIPTION_MAX_LENGTH) {
      throw new SocialPublishError("caption_too_long");
    }
    // `X-Upload-Content-Length` est exigé à l'ouverture : sans taille, pas de
    // session. La médiathèque la connaît et la transmet ; le chemin
    // historique « URL saisie à la main » ne mesure rien, et YouTube y serait
    // alors définitivement impossible. On demande donc la taille au stockage
    // par un `HEAD`, qui ne transfère aucun octet.
    const total =
      typeof input.byteSize === "number" && input.byteSize > 0
        ? input.byteSize
        : await totalFromMedia(input.mediaUrl);
    if (total <= 0) {
      throw new SocialPublishError("media_size_unknown");
    }

    const url = new URL(UPLOAD_ENDPOINT);
    url.searchParams.set("uploadType", "resumable");
    url.searchParams.set("part", "snippet,status");

    const initiation = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(total),
        "x-upload-content-type": "video/*",
      },
      body: JSON.stringify({
        snippet: { title: titre, description: input.caption ?? "" },
        // Imposé côté serveur — voir l'en-tête du module.
        status: { privacyStatus: PRIVACY_STATUS, selfDeclaredMadeForKids: false },
      }),
    });
    if (!initiation.ok) {
      throw await googleFailure(initiation, "resumable init");
    }

    const sessionUri = initiation.headers.get("location");
    if (!sessionUri) {
      // Sans URI, rien n'est reprenable et rien n'a été envoyé : l'échec est
      // net, et une nouvelle tentative repartira proprement de zéro.
      throw new SocialPublishError("container_missing", "youtube resumable: Location absent");
    }
    return sessionUri;
  },

  /**
   * Poursuit l'envoi jusqu'à l'échéance. Chaque morceau est précédé d'une
   * question à Google sur la position réelle — jamais d'une hypothèse.
   */
  async resumeTransfer({ accessToken, containerId, mediaUrl, deadline }) {
    // UNE FENÊTRE TROP COURTE EST UNE ERREUR DE CÂBLAGE, PAS UN ALÉA.
    //
    // Rendre la main en silence laisserait la publication tourner en reprise
    // sans jamais progresser, sans erreur et sans trace — c'est exactement la
    // panne que ce module a produite en production. On refuse donc bruyamment :
    // le code remonte jusqu'à `status_detail`, et un test confronte ce seuil
    // aux budgets réels des deux appelants.
    if (deadline - Date.now() < YOUTUBE_MIN_TRANSFER_BUDGET_MS) {
      throw new SocialPublishError(
        "transfer_window_too_small",
        `youtube transfer: fenêtre < ${YOUTUBE_MIN_TRANSFER_BUDGET_MS} ms`,
      );
    }

    const total = await totalFromMedia(mediaUrl, signalJusqua(deadline));
    if (total <= 0) {
      throw new SocialPublishError("media_unreadable", "youtube media: taille inconnue");
    }

    let pushedBytes = 0;
    try {
      for (;;) {
        if (Date.now() + TRANSFER_TAIL_MS >= deadline) break;

        const signal = signalJusqua(deadline - TRANSFER_TAIL_MS);
        const offset = await sessionOffset(containerId, accessToken, total, signal);
        if (offset === null) break; // Terminé : plus rien à pousser.

        // `pushChunk` qui revient signifie que le PUT est allé au bout : le
        // morceau entier a été accepté. Un abandon en vol sort par le `catch`
        // et ne compte rien — la vérité reste chez Google, pas ici.
        const tailleMorceau = Math.min(offset + CHUNK_SIZE, total) - offset;
        const fini = await pushChunk(containerId, accessToken, mediaUrl, offset, total, signal);
        pushedBytes += tailleMorceau;
        if (fini) break;
      }
    } catch (error) {
      // Un abandon sur échéance n'annule rien : Google conserve ce qu'il a reçu
      // et la reprise suivante repartira de l'octet qu'il confirmera lui-même.
      if (!estAbandon(error)) throw error;
    }
    return { pushedBytes };
  },

  /**
   * L'état du transfert, tel que Google le voit. On ne se fie à aucun compteur
   * local : après un redémarrage, seule la session sait ce qui est arrivé.
   */
  async containerStatus({ accessToken, containerId }): Promise<ContainerStatus> {
    // `bytes */*` est la forme documentée de l'interrogation quand la taille
    // totale n'est pas connue de l'appelant — et elle ne l'est pas ici :
    // `containerStatus` ne reçoit que le jeton et la session, jamais le média.
    try {
      const response = await fetch(containerId, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-range": "bytes */*",
          "content-length": "0",
        },
      });
      if (response.status === 308) return "processing";
      if (response.ok) return "ready";
      if (response.status === 404 || response.status === 410) {
        // Session périmée : rien n'est publiable, et il faudra repartir d'une
        // nouvelle session. On le DIT plutôt que de boucler.
        return "expired";
      }
      throw await googleFailure(response, "session probe");
    } catch (error) {
      if (error instanceof SocialPublishError) throw error;
      throw new SocialPublishError("provider_error", "youtube session probe");
    }
  },

  /**
   * NE PUBLIE PAS. La vidéo existe déjà côté YouTube dès que la session est
   * complète ; cet appel relit la réponse finale pour en extraire l'identifiant,
   * seul moment où Google le communique.
   */
  async publishContainer({ accessToken, containerId }) {
    const response = await fetch(containerId, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-range": "bytes */*",
        "content-length": "0",
      },
    });
    if (!response.ok) {
      throw await googleFailure(response, "session final");
    }
    const payload = (await response.json().catch(() => null)) as { id?: string } | null;
    const videoId = payload?.id;
    if (typeof videoId !== "string" || videoId.length === 0) {
      throw new SocialPublishError("media_id_missing", "youtube: id absent de la reponse finale");
    }
    return { providerMediaId: videoId };
  },

  /** Lien public — direct, aucun appel distant nécessaire. */
  async fetchPermalink({ providerMediaId }) {
    return `${WATCH_URL}${providerMediaId}`;
  },

  // `remoteQuota` : volontairement absent. Le seau `videos.insert` vaut 100
  // envois par jour, mais Google n'expose AUCUN compteur du reste disponible.
  // Le dépassement ne se manifeste que par `uploadLimitExceeded`, traduit plus
  // haut en `remote_quota_exceeded`.
};

/**
 * Taille du média, lue par un `HEAD` sur l'URL signée.
 *
 * La reprise a besoin du total pour former ses `Content-Range`, et elle n'a
 * pas accès aux métadonnées de la médiathèque : le stockage est ici la source
 * la plus fiable, et il répond sans transférer un octet.
 */
async function totalFromMedia(mediaUrl: string, signal?: AbortSignal): Promise<number> {
  const response = await fetch(mediaUrl, { method: "HEAD", signal });
  if (!response.ok) return 0;
  const length = response.headers.get("content-length");
  return length ? Number(length) : 0;
}

export { sessionOffset, totalFromMedia };
