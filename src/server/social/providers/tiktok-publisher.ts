import "server-only";

import { checkVerifiedDelivery } from "@/server/media/delivery";

import { acquireTikTokSlot, TikTokRateLimitError, type TikTokEndpoint } from "./tiktok-rate-limit";
import {
  SocialPublishError,
  type ContainerStatus,
  type CreateContainerInput,
  type SocialPublisher,
} from "./types";

/**
 * Publication TikTok — Content Posting API, mode « Direct Post », transfert
 * du média par PULL_FROM_URL.
 *
 * Documentation officielle vérifiée le 2026-08-31 (developers.tiktok.com,
 * content-posting-api : reference-query-creator-info, reference-direct-post,
 * reference-get-video-status, media-transfer-guide).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUI DIFFÈRE FONDAMENTALEMENT D'INSTAGRAM — à lire avant de modifier
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Chez Instagram, créer un conteneur ne publie RIEN : c'est `media_publish`
 * qui engage. Chez TikTok en Direct Post, `video/init/` ENGAGE DÉJÀ la
 * publication : TikTok télécharge le média puis poste, sans second appel de
 * notre part. Il n'existe aucun moyen d'annuler.
 *
 * Conséquence sur le contrat `SocialPublisher`, respecté à la lettre mais
 * avec un sens décalé :
 *
 *   · `createContainer`  → interroge le créateur, PUIS lance la publication.
 *                          Renvoie le `publish_id`. C'est l'acte engageant.
 *   · `containerStatus`  → `status/fetch/`. « ready » signifie ici
 *                          PUBLISH_COMPLETE : TikTok a déjà posté.
 *   · `publishContainer` → NE PUBLIE PAS. Il relit le statut pour récupérer
 *                          l'identifiant public du post, seul moment où
 *                          TikTok le communique.
 *
 * Cette asymétrie est la raison pour laquelle tout échec APRÈS `video/init/`
 * laisse la ligne `pending` et reprenable : le contenu est peut-être en
 * ligne, et une seconde tentative créerait un doublon sur le compte de
 * l'utilisateur. `resumePublication` interroge le `publish_id` existant — il
 * ne réenvoie jamais le média.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PULL_FROM_URL — pourquoi l'hôte du média est vérifié ICI
 * ─────────────────────────────────────────────────────────────────────────
 *
 * TikTok va chercher le fichier lui-même et impose, sans exception :
 *   · HTTPS ; aucune redirection — « URLs that return HTTP 3xx are
 *     considered invalid » ;
 *   · la PROPRIÉTÉ du domaine prouvée dans le portail développeur. Un domaine
 *     vérifié couvre ses sous-domaines ;
 *   · 4 Go maximum, une heure de téléchargement, 100 Mbit/s en entrée.
 *
 * `postync.app` est vérifié (propriété de domaine, 2026-08-30) : il couvre
 * donc `api.postync.app`, qui servira les médias une fois le domaine
 * personnalisé Supabase actif. Tant que ce n'est pas le cas, les URL signées
 * portent l'hôte `*.supabase.co`, que nous ne possédons pas et ne pouvons pas
 * faire vérifier. Le contrôle ci-dessous refuse alors la publication AVANT
 * tout appel distant, avec un code explicite — plutôt que de laisser TikTok
 * répondre `url_ownership_unverified` après coup, et surtout plutôt que de
 * le découvrir en production.
 */

const API = "https://open.tiktokapis.com/v2";
const CREATOR_INFO_ENDPOINT = `${API}/post/publish/creator_info/query/`;
const VIDEO_INIT_ENDPOINT = `${API}/post/publish/video/init/`;
const STATUS_ENDPOINT = `${API}/post/publish/status/fetch/`;

/** Scope de publication — distinct de `video.upload`, qui ne poste pas. */
export const TIKTOK_PUBLISH_SCOPE = "video.publish";

/** Titre : 2200 runes UTF-16, ce que `String.length` compte exactement. */
const TITLE_MAX_LENGTH = 2200;

/** Durée maximale d'une vidéo publiée par l'API (documentation TikTok). */
export const TIKTOK_MAX_DURATION_SECONDS = 600;

export type TikTokPrivacyLevel =
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "SELF_ONLY";

/**
 * Le client TikTok a-t-il passé l'audit de la Content Posting API ?
 *
 * Tant qu'il ne l'a pas passé, TikTok impose — ce n'est pas une préférence :
 *   · toute publication en `SELF_ONLY` (visible du seul auteur) ;
 *   · des comptes en PRIVÉ au moment de publier ;
 *   · 5 utilisateurs maximum par 24 heures.
 *
 * Demander `PUBLIC_TO_EVERYONE` dans cet état ne donne pas une publication
 * publique : cela donne un refus `unaudited_client_can_only_post_to_private_
 * accounts`. On force donc `SELF_ONLY` en amont, ce qui rend le comportement
 * prévisible et honnête vis-à-vis de l'utilisateur.
 *
 * Le passage à `true` doit SUIVRE l'obtention réelle de l'audit, jamais
 * l'anticiper.
 */
export function isTikTokClientAudited(): boolean {
  return (process.env.TIKTOK_CLIENT_AUDITED ?? "").trim().toLowerCase() === "true";
}

/**
 * Domaine dont la propriété est prouvée dans le portail TikTok. La valeur par
 * défaut correspond à la propriété réellement vérifiée ; l'environnement
 * permet d'en changer sans toucher au code.
 */
export function tiktokVerifiedMediaDomain(): string {
  const brut = (process.env.TIKTOK_VERIFIED_MEDIA_DOMAIN ?? "").trim();
  return brut.length > 0 ? brut : "postync.app";
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type TikTokEnvelope<T> = {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
};

/**
 * Codes d'erreur documentés, ramenés à un code court, stable et enregistrable.
 *
 * Ces valeurs sont une ÉNUMÉRATION publiée par TikTok, pas des données
 * utilisateur : les conserver ne fuite rien. `message`, en revanche, est un
 * texte libre qui peut citer le compte ou l'URL — il ne sort jamais d'ici.
 */
const CODES: Record<string, string> = {
  access_token_invalid: "auth_invalid",
  scope_not_authorized: "missing_scope",
  rate_limit_exceeded: "rate_limited",
  invalid_param: "invalid_param",
  invalid_publish_id: "container_unknown",
  token_not_authorized_for_specified_publish_id: "container_unknown",
  spam_risk_too_many_posts: "remote_quota_exceeded",
  reached_active_user_cap: "remote_quota_exceeded",
  spam_risk_user_banned_from_posting: "account_banned",
  unaudited_client_can_only_post_to_private_accounts: "unaudited_client",
  url_ownership_unverified: "media_host_unverified",
  privacy_level_option_mismatch: "privacy_level_rejected",
};

/**
 * Appel JSON authentifié, créneau de débit compris.
 *
 * Le créneau est réservé AVANT l'envoi : c'est la requête qui compte pour
 * TikTok, pas son issue. Le 429 renvoyé par la plateforme reste traité — le
 * limiteur local ne couvre qu'une instance (voir son en-tête).
 */
async function postJsonRaw<T>(
  endpoint: string,
  slot: TikTokEndpoint,
  accessToken: string,
  body: Record<string, unknown>,
  contexte: string,
): Promise<{ data: T; raw: string }> {
  try {
    await acquireTikTokSlot(slot, accessToken);
  } catch (error) {
    if (error instanceof TikTokRateLimitError) {
      throw new SocialPublishError("rate_limited", `tiktok ${contexte}: rate_limit local`);
    }
    throw error;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });

  // Le corps est lu en TEXTE avant d'être analysé, et le texte est conservé.
  // Raison : TikTok renvoie des `int64` (identifiants de post, ~7,2 × 10^18)
  // que `JSON.parse` convertit en `number` — donc au-delà de
  // `Number.MAX_SAFE_INTEGER`, avec perte des derniers chiffres. Un permalien
  // construit sur un identifiant arrondi pointe vers une vidéo qui n'existe
  // pas. Voir `extractPublicPostId`.
  const raw = await response.text().catch(() => "");
  let payload: TikTokEnvelope<T> | null = null;
  try {
    payload = JSON.parse(raw) as TikTokEnvelope<T>;
  } catch {
    payload = null;
  }

  // TikTok renvoie l'erreur dans le CORPS, y compris en HTTP 200 (piège déjà
  // rencontré sur le serveur d'autorisation le 2026-08-27). On lit donc le
  // code avant de regarder le statut.
  const code = payload?.error?.code;
  if (typeof code === "string" && code.length > 0 && code !== "ok") {
    throw new SocialPublishError(CODES[code] ?? code, `tiktok ${contexte}: ${code}`);
  }
  if (!response.ok) {
    throw new SocialPublishError(
      `http_${response.status}`,
      `tiktok ${contexte}: HTTP ${response.status}`,
    );
  }
  if (!payload?.data) {
    throw new SocialPublishError("empty_response", `tiktok ${contexte}: reponse sans data`);
  }
  return { data: payload.data, raw };
}

/** Variante courante : seules les données analysées intéressent l'appelant. */
async function postJson<T>(
  endpoint: string,
  slot: TikTokEndpoint,
  accessToken: string,
  body: Record<string, unknown>,
  contexte: string,
): Promise<T> {
  const { data } = await postJsonRaw<T>(endpoint, slot, accessToken, body, contexte);
  return data;
}

/**
 * Premier identifiant public de post, lu SUR LE TEXTE brut de la réponse.
 *
 * `JSON.parse` ne peut pas restituer un `int64` : 7248000000000000123 devient
 * 7248000000000000000, et le lien publié est mort. Les chiffres sont donc
 * relevés tels quels. TikTok documente une liste (un même `publish_id` peut
 * donner plusieurs posts) et un entier ; la forme « chaîne » est acceptée par
 * prudence, elle ne coûte rien et couvre un changement de sérialisation.
 */
export function extractPublicPostId(raw: string): string | null {
  const trouve = /"publicaly_available_post_id"\s*:\s*\[\s*"?(\d+)"?/.exec(raw);
  return trouve ? trouve[1] : null;
}

// ---------------------------------------------------------------------------
// Creator info
// ---------------------------------------------------------------------------

export type TikTokCreatorInfo = {
  username: string | null;
  nickname: string | null;
  privacyLevelOptions: TikTokPrivacyLevel[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDurationSeconds: number | null;
};

type CreatorInfoPayload = {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
};

/**
 * `creator_info/query` — OBLIGATOIRE avant chaque publication.
 *
 * Ce n'est pas une formalité : c'est la seule source des options de
 * confidentialité réellement ouvertes à CE compte, des réglages
 * commentaire/duo/couture que la charte TikTok impose de respecter, et de la
 * durée maximale autorisée pour CE créateur — qui n'est pas une constante.
 */
export async function queryCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
  const data = await postJson<CreatorInfoPayload>(
    CREATOR_INFO_ENDPOINT,
    "creatorInfo",
    accessToken,
    {},
    "creator_info",
  );
  return {
    username: data.creator_username ?? null,
    nickname: data.creator_nickname ?? null,
    privacyLevelOptions: (data.privacy_level_options ?? []).filter((option): option is TikTokPrivacyLevel =>
      PRIVACY_LEVELS.includes(option as TikTokPrivacyLevel),
    ),
    // Absent vaut FAUX, et non « inconnu » : la valeur ne sert qu'à ne pas
    // contredire un réglage explicitement désactivé.
    commentDisabled: data.comment_disabled === true,
    duetDisabled: data.duet_disabled === true,
    stitchDisabled: data.stitch_disabled === true,
    maxDurationSeconds:
      typeof data.max_video_post_duration_sec === "number" && data.max_video_post_duration_sec > 0
        ? data.max_video_post_duration_sec
        : null,
  };
}

const PRIVACY_LEVELS: readonly TikTokPrivacyLevel[] = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
];

/**
 * Niveau de confidentialité effectif.
 *
 * Deux règles, dans cet ordre — l'ordre est le fond du sujet :
 *   1. client non audité → `SELF_ONLY`, sans discussion possible ;
 *   2. le niveau retenu doit figurer dans les options renvoyées par
 *      `creator_info`. TikTok refuse sinon (`privacy_level_option_mismatch`),
 *      et un compte privé n'expose par exemple pas `PUBLIC_TO_EVERYONE`.
 */
export function resolvePrivacyLevel(
  options: readonly TikTokPrivacyLevel[],
  audited: boolean,
  requested?: TikTokPrivacyLevel | null,
): TikTokPrivacyLevel {
  const souhaite: TikTokPrivacyLevel = audited ? (requested ?? "PUBLIC_TO_EVERYONE") : "SELF_ONLY";

  if (!options.includes(souhaite)) {
    // Se rabattre silencieusement sur autre chose changerait la visibilité du
    // contenu à l'insu de l'utilisateur : on refuse, et on le dit.
    throw new SocialPublishError(
      "privacy_level_unavailable",
      `tiktok privacy: ${souhaite} indisponible`,
    );
  }
  return souhaite;
}

// ---------------------------------------------------------------------------
// Statuts
// ---------------------------------------------------------------------------

type StatusPayload = {
  status?: string;
  fail_reason?: string;
  publicaly_available_post_id?: Array<number | string>;
  downloaded_bytes?: number;
  uploaded_bytes?: number;
};

/**
 * Statuts officiels, ramenés à notre vocabulaire.
 *
 * `PUBLISH_COMPLETE` devient « ready » et NON « published » : le moteur
 * appelle alors `publishContainer`, seul endroit d'où l'on peut récupérer
 * l'identifiant public du post. Retourner « published » ferait enregistrer le
 * `publish_id` à la place — un identifiant interne, sans lien cliquable.
 */
export function normalizeTikTokStatus(status: string | undefined): ContainerStatus {
  switch (status) {
    case "PUBLISH_COMPLETE":
      return "ready";
    case "FAILED":
      return "failed";
    case "PROCESSING_UPLOAD":
    case "PROCESSING_DOWNLOAD":
    case "SEND_TO_USER_INBOX":
      return "processing";
    default:
      // Un statut inconnu n'est jamais « prêt ».
      return "processing";
  }
}

async function fetchStatus(
  accessToken: string,
  publishId: string,
): Promise<{ data: StatusPayload; raw: string }> {
  return postJsonRaw<StatusPayload>(
    STATUS_ENDPOINT,
    "statusFetch",
    accessToken,
    { publish_id: publishId },
    "status",
  );
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

export const tiktokPublisher: SocialPublisher = {
  requiredScopes: [TIKTOK_PUBLISH_SCOPE],
  // Cette API ne publie pas d'image isolée : vidéo uniquement.
  supportedMediaKinds: ["reel"],

  /**
   * ATTENTION — cet appel ENGAGE la publication (voir l'en-tête du module).
   * Tous les contrôles locaux passent donc AVANT `video/init/`.
   */
  async createContainer(input: CreateContainerInput): Promise<string> {
    if (input.mediaKind !== "reel") {
      throw new SocialPublishError("unsupported_media");
    }
    if (input.caption && input.caption.length > TITLE_MAX_LENGTH) {
      throw new SocialPublishError("caption_too_long");
    }

    // L'hôte du média doit appartenir au domaine vérifié : TikTok ira le
    // chercher, et refuse tout ce qui n'est pas prouvé nôtre.
    const refus = checkVerifiedDelivery(input.mediaUrl, tiktokVerifiedMediaDomain());
    if (refus !== null) {
      throw new SocialPublishError(
        refus === "host_not_verified" ? "media_host_unverified" : `media_url_${refus}`,
        `tiktok media_url: ${refus}`,
      );
    }

    // Options du créateur : obligatoire, et jamais mis en cache — un compte
    // peut passer en privé entre deux publications.
    const creator = await queryCreatorInfo(input.accessToken);

    // Durée : le plafond dépend DU CRÉATEUR. Le contrôle générique de la
    // médiathèque ne peut pas le connaître, celui-ci si.
    const plafond = creator.maxDurationSeconds ?? TIKTOK_MAX_DURATION_SECONDS;
    if (typeof input.durationSeconds === "number" && input.durationSeconds > plafond) {
      throw new SocialPublishError("media_too_long", `tiktok duration: > ${plafond}s`);
    }

    const privacyLevel = resolvePrivacyLevel(
      creator.privacyLevelOptions,
      isTikTokClientAudited(),
      input.privacyLevel as TikTokPrivacyLevel | null | undefined,
    );

    const data = await postJson<{ publish_id?: string }>(
      VIDEO_INIT_ENDPOINT,
      "videoInit",
      input.accessToken,
      {
        post_info: {
          title: input.caption ?? "",
          privacy_level: privacyLevel,
          // Les réglages du créateur ne sont pas indicatifs : la charte TikTok
          // impose de les respecter. On ne les désactive jamais de nous-mêmes,
          // on se contente de ne pas les contredire.
          disable_comment: creator.commentDisabled,
          disable_duet: creator.duetDisabled,
          disable_stitch: creator.stitchDisabled,
        },
        source_info: {
          source: "PULL_FROM_URL",
          video_url: input.mediaUrl,
        },
      },
      "video/init",
    );

    const publishId = data.publish_id;
    if (typeof publishId !== "string" || publishId.length === 0) {
      // Cas redoutable : TikTok a peut-être accepté la tâche sans que nous
      // sachions l'identifier. Rien à reprendre, et surtout rien à réessayer.
      throw new SocialPublishError("container_missing", "tiktok video/init: publish_id absent");
    }
    return publishId;
  },

  async containerStatus({ accessToken, containerId }): Promise<ContainerStatus> {
    const { data } = await fetchStatus(accessToken, containerId);
    const statut = normalizeTikTokStatus(data.status);
    if (statut === "failed") {
      // `fail_reason` est une énumération documentée : la journaliser donne le
      // diagnostic (format, durée, téléchargement, bannissement…) sans exposer
      // la moindre donnée du compte.
      console.error(`[social:publish] tiktok fail_reason: ${data.fail_reason ?? "inconnu"}`);
    }
    return statut;
  },

  /**
   * NE PUBLIE PAS. TikTok a déjà posté quand on arrive ici (statut « ready »
   * = PUBLISH_COMPLETE). Cet appel relit le statut pour obtenir l'identifiant
   * PUBLIC du post, que TikTok ne communique qu'à ce moment — et seulement si
   * le contenu est public et validé par la modération.
   *
   * En `SELF_ONLY` — le cas d'un client non audité — cet identifiant n'existe
   * pas. On conserve alors le `publish_id`, seule référence légitime :
   * inventer un identifiant public serait pire que ne rien avoir.
   */
  async publishContainer({ accessToken, containerId }) {
    const reponse = await fetchStatus(accessToken, containerId).catch(() => null);
    // Lecture sur le TEXTE : l'identifiant est un int64 que `JSON.parse`
    // arrondirait (voir `extractPublicPostId`).
    const publicId = reponse ? extractPublicPostId(reponse.raw) : null;
    return { providerMediaId: publicId ?? containerId };
  },

  /**
   * Lien public — strictement best effort.
   *
   * Il n'a de sens que pour un identifiant PUBLIC de post ; le `publish_id`
   * n'en a pas. On ne dépense donc un appel `creator_info` (pour le nom
   * d'utilisateur, seule pièce manquante de l'URL) que dans ce cas — ce qui,
   * client non audité, revient à n'en dépenser aucun.
   */
  async fetchPermalink({ accessToken, providerMediaId }) {
    if (!/^\d+$/.test(providerMediaId)) return null;
    const creator = await queryCreatorInfo(accessToken).catch(() => null);
    if (!creator?.username) return null;
    return `https://www.tiktok.com/@${creator.username}/video/${providerMediaId}`;
  },

  // `remoteQuota` : volontairement absent. TikTok n'expose AUCUN compteur de
  // publications restantes — les plafonds ne se manifestent que par un refus
  // (`spam_risk_too_many_posts`, `reached_active_user_cap`), traduit plus haut
  // en `remote_quota_exceeded`. Rendre `null` en permanence donnerait
  // l'illusion d'une mesure qui n'existe pas.
};
