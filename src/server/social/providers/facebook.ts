import "server-only";

import {
  SocialPublishError,
  type ContainerStatus,
  type CreateContainerInput,
  type SocialAsset,
  type SocialAssetSelector,
  type SocialProvider,
  type SocialPublisher,
  type TokenSet,
} from "./types";

/**
 * Provider Facebook — Pages.
 *
 * Vérifié le 2026-08-27 sur developers.facebook.com (facebook-login,
 * graph-api/reference/user/accounts, video-api/guides/reels-publishing,
 * permissions, app-modes).
 *
 * CE QUI DISTINGUE FACEBOOK DES TROIS AUTRES RÉSEAUX
 *
 * Une autorisation ne donne pas UN compte mais N Pages. Le provider expose
 * donc `assets` au lieu de `fetchIdentity` : le callback met la connexion en
 * attente et l'utilisateur choisit ses Pages. Chaque Page retenue devient une
 * ligne `social_accounts` à part entière, avec SON jeton de Page — le jeton
 * utilisateur, lui, ne survit pas à la sélection.
 *
 * AUTORISATION
 *
 *   - dialogue `https://www.facebook.com/v25.0/dialog/oauth` avec `scope`.
 *     Meta recommande `config_id` (Login for Business), mais `scope` reste
 *     documenté et accepté : on garde les permissions DANS LE CODE, comme
 *     pour les autres providers, plutôt que dans un objet du tableau de bord.
 *   - aucun PKCE documenté pour ce flux → `usesPkce: false`.
 *
 * JETONS — rien n'est supposé « permanent »
 *
 *   - le jeton utilisateur court est échangé contre un jeton longue durée
 *     (~60 jours) via `fb_exchange_token` ;
 *   - les jetons de PAGE dérivés d'un jeton utilisateur longue durée n'ont
 *     PAS de date d'expiration — mais ils restent invalidables (mot de passe
 *     changé, application retirée, rôle perdu sur la Page, événement de
 *     sécurité Meta). « Sans date d'expiration » n'est donc PAS « éternel » :
 *     `token_expires_at` reste null et l'invalidation se constate à l'usage.
 *
 * PUBLICATION D'UN REEL — trois phases, pas deux
 *
 *   1. `POST /<PAGE_ID>/video_reels` (`upload_phase=start`) → `video_id` ;
 *   2. `POST rupload.facebook.com/video-upload/<v>/<VIDEO_ID>` avec l'en-tête
 *      `file_url` pointant sur le média public (pas d'upload binaire ici) ;
 *   3. `POST /<PAGE_ID>/video_reels` (`upload_phase=finish`,
 *      `video_state=PUBLISHED`).
 *
 * Contraintes Reel BEAUCOUP plus strictes qu'Instagram : 3 à 90 secondes,
 * ratio 9:16, minimum 540 × 960, 24 à 60 FPS. Quota 30 publications / 24 h.
 * Les URL `fbcdn` sont rejetées.
 */

const API_VERSION = "v25.0";
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;
const RUPLOAD = `https://rupload.facebook.com/video-upload/${API_VERSION}`;
const DIALOG = `https://www.facebook.com/${API_VERSION}/dialog/oauth`;

/**
 * Moindre privilège. `pages_show_list` et `pages_read_engagement` suffisent à
 * lister et identifier les Pages ; `pages_manage_posts` est ce qui autorise
 * la publication. Vérifié : `publish_video` n'est PAS requis pour les Reels —
 * il concerne la vidéo en direct.
 */
export const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
];

/** Tâche Meta exigée sur une Page pour pouvoir y publier. */
const CREATE_CONTENT = "CREATE_CONTENT";

function appId(): string {
  return process.env.META_CLIENT_ID ?? "";
}
function appSecret(): string {
  return process.env.META_CLIENT_SECRET ?? "";
}

export function isFacebookConfigured(): boolean {
  return appId().length > 0 && appSecret().length > 0;
}

/** Code d'erreur court d'une réponse Meta — jamais le corps complet. */
async function metaErrorCode(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: { code?: number; error_subcode?: number; type?: string; message?: string };
    };
    if (!payload.error) return "";
    // `message` peut contenir un identifiant de compte : on ne garde que le
    // type et les codes numériques.
    return [payload.error.type, payload.error.code, payload.error.error_subcode]
      .filter((part) => part !== undefined && part !== null)
      .join("/");
  } catch {
    return "";
  }
}

type TokenPayload = { access_token?: string; token_type?: string; expires_in?: number };

/**
 * Échange `fb_exchange_token` : jeton court → jeton utilisateur longue durée
 * (~60 jours). Sans lui, les jetons de Page dérivés seraient eux aussi de
 * courte durée.
 */
async function exchangeForLongLivedUserToken(shortLivedToken: string): Promise<TokenPayload> {
  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId());
  url.searchParams.set("client_secret", appSecret());
  url.searchParams.set("fb_exchange_token", shortLivedToken);

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(
      `facebook fb_exchange_token: HTTP ${response.status} ${await metaErrorCode(response)}`,
    );
  }
  return (await response.json()) as TokenPayload;
}

// ---------------------------------------------------------------------------
// Sélection des Pages
// ---------------------------------------------------------------------------

export const facebookAssets: SocialAssetSelector = {
  async listAssets(userAccessToken): Promise<SocialAsset[]> {
    const assets: SocialAsset[] = [];
    // `/me/accounts` est paginé : un gestionnaire d'agence peut administrer
    // beaucoup de Pages, on suit `paging.next` jusqu'au bout.
    let next: string | null = (() => {
      const url = new URL(`${GRAPH}/me/accounts`);
      url.searchParams.set("fields", "id,name,access_token,category,tasks,picture{url}");
      url.searchParams.set("limit", "100");
      url.searchParams.set("access_token", userAccessToken);
      return url.toString();
    })();

    // Garde-fou : jamais de boucle infinie sur une pagination inattendue.
    for (let page = 0; next && page < 20; page += 1) {
      const response: Response = await fetch(next, { method: "GET" });
      if (!response.ok) {
        throw new Error(
          `facebook me/accounts: HTTP ${response.status} ${await metaErrorCode(response)}`,
        );
      }
      const payload = (await response.json()) as {
        data?: Array<{
          id?: string;
          name?: string;
          access_token?: string;
          tasks?: string[];
          picture?: { data?: { url?: string } };
        }>;
        paging?: { next?: string };
      };

      for (const item of payload.data ?? []) {
        // Une Page sans jeton n'est pas exploitable : on ne la propose pas.
        if (!item.id || !item.access_token) continue;
        assets.push({
          assetId: item.id,
          name: item.name ?? item.id,
          avatarUrl: item.picture?.data?.url ?? null,
          token: item.access_token,
          // Une Page que l'utilisateur ne fait qu'analyser ne doit pas être
          // présentée comme publiable.
          canPublish: (item.tasks ?? []).includes(CREATE_CONTENT),
        });
      }
      next = payload.paging?.next ?? null;
    }
    return assets;
  },
};

// ---------------------------------------------------------------------------
// Publication d'un Reel sur une Page
// ---------------------------------------------------------------------------

const CAPTION_MAX_LENGTH = 2200;

type ReelStatusPayload = {
  status?: {
    video_status?: string;
    uploading_phase?: { status?: string };
    processing_phase?: { status?: string };
  };
};

function normalizeReelStatus(payload: ReelStatusPayload): ContainerStatus {
  const status = payload.status;
  if (!status) return "processing";
  if (status.video_status === "ready") return "ready";
  if (status.processing_phase?.status === "error" || status.uploading_phase?.status === "error") {
    return "failed";
  }
  // Tout le reste (uploading, processing) reste « en cours » : on ne publie
  // jamais sur la foi d'un statut qu'on ne comprend pas.
  return "processing";
}

export const facebookPublisher: SocialPublisher = {
  requiredScopes: ["pages_manage_posts"],
  // Les Reels seulement pour l'instant : une photo de Page passe par un autre
  // endpoint (`/photos`), qui viendra avec son propre travail de vérification.
  supportedMediaKinds: ["reel"],

  /**
   * Phases 1 et 2 : initialisation puis transfert par URL. Le « conteneur »
   * de notre abstraction est ici le `video_id` de Facebook.
   */
  async createContainer(input: CreateContainerInput): Promise<string> {
    if (input.caption && input.caption.length > CAPTION_MAX_LENGTH) {
      throw new SocialPublishError("caption_too_long");
    }

    const startResponse = await fetch(`${GRAPH}/${input.providerAccountId}/video_reels`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        upload_phase: "start",
        access_token: input.accessToken,
      }).toString(),
    });
    if (!startResponse.ok) {
      throw new SocialPublishError(
        `http_${startResponse.status}`,
        `facebook video_reels start: HTTP ${startResponse.status} ${await metaErrorCode(startResponse)}`,
      );
    }
    const started = (await startResponse.json()) as { video_id?: string | number };
    if (started.video_id === undefined || started.video_id === null) {
      throw new SocialPublishError("container_missing");
    }
    const videoId = String(started.video_id);

    // Phase 2 : le média est référencé par URL publique via l'en-tête
    // `file_url` — aucun octet ne transite par POSTYNC.
    const uploadResponse = await fetch(`${RUPLOAD}/${videoId}`, {
      method: "POST",
      headers: {
        authorization: `OAuth ${input.accessToken}`,
        file_url: input.mediaUrl,
      },
    });
    if (!uploadResponse.ok) {
      throw new SocialPublishError(
        `http_${uploadResponse.status}`,
        `facebook rupload: HTTP ${uploadResponse.status} ${await metaErrorCode(uploadResponse)}`,
      );
    }

    return videoId;
  },

  async containerStatus({ accessToken, containerId }): Promise<ContainerStatus> {
    const url = new URL(`${GRAPH}/${containerId}`);
    url.searchParams.set("fields", "status");
    url.searchParams.set("access_token", accessToken);

    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new SocialPublishError(
        `http_${response.status}`,
        `facebook video status: HTTP ${response.status} ${await metaErrorCode(response)}`,
      );
    }
    return normalizeReelStatus((await response.json()) as ReelStatusPayload);
  },

  /**
   * Phase 3 : publication effective du Reel.
   *
   * C'est ICI que se pose la légende, via `description` — contrairement à
   * Instagram qui la porte sur le conteneur. L'envoyer à la phase `start`
   * n'aurait aucun effet : le Reel serait publié sans texte.
   */
  async publishContainer({ accessToken, providerAccountId, containerId, caption }) {
    const params: Record<string, string> = {
      upload_phase: "finish",
      video_id: containerId,
      video_state: "PUBLISHED",
      access_token: accessToken,
    };
    if (caption) params.description = caption;

    const response = await fetch(`${GRAPH}/${providerAccountId}/video_reels`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) {
      throw new SocialPublishError(
        `http_${response.status}`,
        `facebook video_reels finish: HTTP ${response.status} ${await metaErrorCode(response)}`,
      );
    }
    // La phase `finish` ne renvoie pas d'identifiant de média : le Reel EST
    // la vidéo créée en phase 1.
    return { providerMediaId: containerId };
  },

  async fetchPermalink({ accessToken, providerMediaId }) {
    const url = new URL(`${GRAPH}/${providerMediaId}`);
    url.searchParams.set("fields", "permalink_url");
    url.searchParams.set("access_token", accessToken);
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) return null;
    const payload = (await response.json()) as { permalink_url?: string };
    if (!payload.permalink_url) return null;
    // Meta renvoie un chemin relatif à facebook.com.
    return payload.permalink_url.startsWith("http")
      ? payload.permalink_url
      : `https://www.facebook.com${payload.permalink_url}`;
  },
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const facebookProvider: SocialProvider = {
  platform: "facebook",
  usesPkce: false,

  buildAuthUrl({ state, redirectUri }) {
    const url = new URL(DIALOG);
    url.searchParams.set("client_id", appId());
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", FACEBOOK_SCOPES.join(","));
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode({ code, redirectUri }): Promise<TokenSet> {
    const url = new URL(`${GRAPH}/oauth/access_token`);
    url.searchParams.set("client_id", appId());
    url.searchParams.set("client_secret", appSecret());
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code", code);

    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(`facebook token: HTTP ${response.status} ${await metaErrorCode(response)}`);
    }
    const short = (await response.json()) as TokenPayload;
    if (!short.access_token) {
      throw new Error("facebook token: réponse sans access_token");
    }

    // Le jeton court ne sert qu'à obtenir le jeton longue durée : c'est lui
    // qui donnera des jetons de Page sans date d'expiration.
    const long = await exchangeForLongLivedUserToken(short.access_token);
    if (!long.access_token) {
      throw new Error("facebook fb_exchange_token: réponse sans access_token");
    }

    return {
      accessToken: long.access_token,
      refreshToken: null,
      expiresAt:
        typeof long.expires_in === "number"
          ? new Date(Date.now() + long.expires_in * 1000).toISOString()
          : null,
      refreshExpiresAt: null,
      scopes: FACEBOOK_SCOPES,
    };
  },

  // fetchIdentity absent : ce provider expose des ACTIFS, pas une identité
  // unique. Le callback met la connexion en attente et l'utilisateur choisit.
  assets: facebookAssets,
  publisher: facebookPublisher,

  // revoke : `DELETE /<user-id>/permissions` révoque l'autorisation de
  // l'utilisateur, donc TOUTES ses Pages d'un coup. Déconnecter une Page ne
  // doit pas couper les autres : la révocation n'est volontairement pas
  // câblée ici. Voir FACEBOOK_REVOKE_NOTICE.
  revokeNotice:
    "La déconnexion retire cette Page de POSTYNC. Pour révoquer complètement " +
    "l'accès de l'application, ouvrez Facebook puis Paramètres › Applications " +
    "et sites web.",
};
