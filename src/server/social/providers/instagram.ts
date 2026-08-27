import "server-only";

import {
  SocialPublishError,
  type ContainerStatus,
  type CreateContainerInput,
  type SocialIdentity,
  type SocialProvider,
  type SocialPublisher,
  type TokenSet,
} from "./types";

/**
 * Provider Instagram — configuration « Instagram API with Instagram Login »
 * (Business Login for Instagram), retenue en C8.4 (docs/META_ARCHITECTURE.md).
 *
 * Implémentation strictement alignée sur la documentation officielle Meta
 * (developers.facebook.com/docs/instagram-platform, section
 * instagram-api-with-instagram-login/business-login — vérifiée le 2026-08-26) :
 *
 *   - identifiants : `client_id` = **Instagram App ID**, `client_secret` =
 *     **Instagram App Secret**. Ce ne sont PAS l'App ID / App Secret Facebook :
 *     d'où des variables dédiées `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`,
 *     distinctes de `META_CLIENT_*` que réservera l'intégration Facebook ;
 *
 *   - autorisation : https://www.instagram.com/oauth/authorize, scopes séparés
 *     par des VIRGULES. Aucun PKCE documenté pour ce flux → `usesPkce: false`
 *     (le CSRF est couvert par notre `state` à usage unique, C8.1) ;
 *
 *   - PIÈGE OFFICIEL : le code d'autorisation est renvoyé avec `#_` accolé —
 *     « The `#_` appended to the end of the redirect URI is not part of the
 *     code itself, so strip it out ». Retiré ici par sécurité, même si un
 *     fragment n'atteint normalement pas le serveur ;
 *
 *   - jetons — VÉRIFIÉ, rien n'est supposé « non expirant » :
 *       · le token issu de l'échange est COURT (1 heure) et donc inutilisable
 *         tel quel : `exchangeCode` enchaîne SYSTÉMATIQUEMENT l'échange
 *         longue durée `ig_exchange_token` (~60 jours) ;
 *       · Instagram ne délivre AUCUN refresh token distinct. Le token longue
 *         durée se rafraîchit LUI-MÊME via `ig_refresh_token`, ce qui redonne
 *         60 jours. `refreshToken` reste donc `null` (fidèle à la réalité,
 *         aucun secret dupliqué dans Vault) et `refreshUsesAccessToken` signale
 *         à l'appelant qu'il doit passer l'access token courant à `refresh()` ;
 *       · précondition officielle du rafraîchissement : le token doit avoir au
 *         moins 24 heures et être encore valide. Passé 60 jours sans
 *         rafraîchissement, il n'y a plus de rattrapage : le compte bascule
 *         « expiré » et l'utilisateur reconnecte (parcours C8.1) ;
 *
 *   - révocation : Meta ne documente AUCUN endpoint de révocation pour cette
 *     configuration. `revoke` n'est donc volontairement PAS implémenté — plutôt
 *     que d'appeler une URL non documentée. La déconnexion POSTYNC supprime la
 *     ligne et purge Vault ; le retrait de l'autorisation côté Instagram se
 *     fait par l'utilisateur dans ses réglages. Voir `INSTAGRAM_REVOKE_NOTICE` ;
 *
 *   - moindre privilège : `instagram_business_basic` seul. AUCUNE publication
 *     en C8.4a — `instagram_business_content_publish` viendra avec l'étape
 *     publication et son App Review dédiée.
 */

const AUTH_ENDPOINT = "https://www.instagram.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.instagram.com/oauth/access_token";
const GRAPH_HOST = "https://graph.instagram.com";

/**
 * Version d'API épinglée : celle employée par les exemples de la
 * documentation Instagram Platform (donc la surface réellement documentée),
 * valable jusqu'au 29/07/2028. Un appel non versionné suit les bascules de
 * Meta sans prévenir — on préfère un changement explicite ici.
 * Les endpoints OAuth (`/access_token`, `/refresh_access_token`) ne sont PAS
 * versionnés dans la documentation : ils restent tels quels.
 */
const API_VERSION = "v25.0";
const GRAPH_API = `${GRAPH_HOST}/${API_VERSION}`;

const LONG_LIVED_ENDPOINT = `${GRAPH_HOST}/access_token`;
const REFRESH_ENDPOINT = `${GRAPH_HOST}/refresh_access_token`;
const ME_ENDPOINT = `${GRAPH_API}/me`;

/** Identité (C8.4a). */
export const INSTAGRAM_BASIC_SCOPE = "instagram_business_basic";
/** Publication (C8.4b) — soumis à App Review pour l'accès avancé. */
export const INSTAGRAM_PUBLISH_SCOPE = "instagram_business_content_publish";

/**
 * Scopes demandés à l'autorisation. La publication fait partie du produit :
 * la demander dès la connexion évite un second passage par le consentement.
 * Un compte connecté AVANT l'ajout de ce scope ne l'a pas : `publish.ts`
 * vérifie les scopes réellement accordés et demande une reconnexion.
 */
export const INSTAGRAM_SCOPES = [INSTAGRAM_BASIC_SCOPE, INSTAGRAM_PUBLISH_SCOPE];

/**
 * Meta ne documente pas de révocation côté app pour cette configuration :
 * message affiché à l'utilisateur après une déconnexion.
 */
export const INSTAGRAM_REVOKE_NOTICE =
  "Instagram ne permet pas à une application de révoquer son propre accès. " +
  "Pour retirer complètement l'autorisation, ouvrez Instagram puis " +
  "Paramètres › Sécurité › Applications et sites web.";

/**
 * Champs de profil. Seuls `user_id` et `username` sont documentés pour cette
 * configuration ; les autres le sont pour la configuration Facebook Login.
 * Une demande de champ inconnu renvoie HTTP 400 chez Meta (pas une omission
 * silencieuse) : on tente donc le jeu enrichi, et on retombe sur le jeu
 * documenté en cas de refus, plutôt que de risquer un échec de connexion.
 */
const PROFILE_FIELDS_RICH = "user_id,username,name,account_type,profile_picture_url";
const PROFILE_FIELDS_MINIMAL = "user_id,username";

function appId(): string {
  return process.env.INSTAGRAM_APP_ID ?? "";
}
function appSecret(): string {
  return process.env.INSTAGRAM_APP_SECRET ?? "";
}

export function isInstagramConfigured(): boolean {
  return appId().length > 0 && appSecret().length > 0;
}

/**
 * `#_` documenté par Meta, et `#…` par prudence : un fragment ne doit jamais
 * se retrouver dans le code envoyé au endpoint de token.
 */
export function stripCodeFragment(code: string): string {
  const hash = code.indexOf("#");
  return hash === -1 ? code : code.slice(0, hash);
}

/**
 * Meta enveloppe plusieurs réponses de cette configuration dans un tableau
 * `data` (`{"data":[{…}]}`) là où d'autres endpoints répondent à plat. Les deux
 * formes sont acceptées : la documentation n'est pas homogène et une réponse
 * inattendue ne doit pas casser une connexion.
 */
function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    const data = (payload as { data: unknown }).data;
    if (Array.isArray(data)) {
      return (data[0] ?? {}) as T;
    }
    if (data && typeof data === "object") {
      return data as T;
    }
  }
  return (payload ?? {}) as T;
}

/** Code d'erreur court d'une réponse Meta — jamais le corps complet. */
async function metaErrorCode(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: { code?: number; error_subcode?: number; type?: string; message?: string };
      error_type?: string;
      error_message?: string;
      code?: number;
    };
    if (payload.error) {
      // `message` Meta peut contenir l'identifiant du compte : on ne garde
      // que le type et les codes numériques.
      return [payload.error.type, payload.error.code, payload.error.error_subcode]
        .filter((part) => part !== undefined && part !== null)
        .join("/");
    }
    return payload.error_type ?? String(payload.code ?? "");
  } catch {
    return "";
  }
}

type LongLivedPayload = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
};

/**
 * Un token longue durée Instagram porte sa propre péremption. Le
 * rafraîchissement se fait avec le token lui-même : `refreshExpiresAt` suit
 * donc exactement `expiresAt` — passé cette date, plus aucun rattrapage.
 */
function toTokenSet(payload: LongLivedPayload, scopes: string[]): TokenSet {
  if (!payload.access_token) {
    throw new Error("réponse token sans access_token");
  }
  const expiresAt =
    typeof payload.expires_in === "number"
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : null;
  return {
    accessToken: payload.access_token,
    refreshToken: null,
    expiresAt,
    refreshExpiresAt: expiresAt,
    scopes,
  };
}

/** Échange `ig_exchange_token` : token court (1 h) → token longue durée (~60 j). */
async function exchangeForLongLived(shortLivedToken: string, scopes: string[]): Promise<TokenSet> {
  const url = new URL(LONG_LIVED_ENDPOINT);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", appSecret());
  url.searchParams.set("access_token", shortLivedToken);

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`instagram ig_exchange_token: HTTP ${response.status} ${await metaErrorCode(response)}`);
  }
  return toTokenSet((await response.json()) as LongLivedPayload, scopes);
}

/**
 * Publication Instagram — « Content Publishing », vérifié le 2026-08-27 sur
 * developers.facebook.com/docs/instagram-platform/content-publishing.
 *
 *   - hôte : `graph.instagram.com` (la mention `graph.facebook.com` de la
 *     documentation concerne la configuration Facebook Login, pas la nôtre) ;
 *   - deux temps OBLIGATOIRES : `POST /<IG_ID>/media` crée un conteneur, puis
 *     `POST /<IG_ID>/media_publish` le publie. Entre les deux, un Reel est
 *     transcodé : le conteneur n'est publiable qu'une fois `FINISHED` ;
 *   - le média doit être servi depuis une URL PUBLIQUE : aucun upload direct
 *     dans cette configuration ;
 *   - un conteneur non publié EXPIRE au bout de 24 h — d'où la reprise plutôt
 *     qu'un renvoi du média ;
 *   - quota plateforme : 100 publications par 24 h glissantes, lisible sur
 *     `GET /<IG_ID>/content_publishing_limit`. Il est DISTINCT du quota du
 *     plan POSTYNC, qui est vérifié séparément.
 *
 * Spécifications Reel officielles (contrôlées avant l'envoi côté serveur) :
 * MP4/MOV, H264 ou HEVC, 3 s à 15 min, 300 Mo maximum, 23 à 60 FPS,
 * ratio 9:16 recommandé. Légende : 2200 caractères, 30 hashtags, 20 mentions.
 */
const CAPTION_MAX_LENGTH = 2200;

type ContainerStatusPayload = { status_code?: string; id?: string };

/** Statuts officiels du conteneur, ramenés à notre vocabulaire. */
function normalizeContainerStatus(code: string | undefined): ContainerStatus {
  switch (code) {
    case "FINISHED":
      return "ready";
    case "IN_PROGRESS":
      return "processing";
    case "PUBLISHED":
      return "published";
    case "EXPIRED":
      return "expired";
    case "ERROR":
      return "failed";
    default:
      // Un statut inconnu n'est pas « prêt » : on ne publie jamais au hasard.
      return "processing";
  }
}

async function postGraph(
  path: string,
  accessToken: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ ...params, access_token: accessToken });
  const response = await fetch(`${GRAPH_API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    // Le code court suffit au diagnostic ; le corps Meta peut contenir des
    // identifiants et n'est jamais propagé.
    throw new SocialPublishError(
      `http_${response.status}`,
      `instagram ${path}: HTTP ${response.status} ${await metaErrorCode(response)}`,
    );
  }
  return unwrap<Record<string, unknown>>(await response.json());
}

export const instagramPublisher: SocialPublisher = {
  requiredScopes: [INSTAGRAM_PUBLISH_SCOPE],
  supportedMediaKinds: ["reel", "image"],

  async createContainer(input: CreateContainerInput): Promise<string> {
    if (input.caption && input.caption.length > CAPTION_MAX_LENGTH) {
      throw new SocialPublishError("caption_too_long");
    }

    const params: Record<string, string> = {};
    if (input.mediaKind === "reel") {
      params.media_type = "REELS";
      params.video_url = input.mediaUrl;
      if (input.coverUrl) params.cover_url = input.coverUrl;
      // `share_to_feed` n'existe que pour les Reels.
      if (input.shareToFeed !== undefined) params.share_to_feed = String(input.shareToFeed);
    } else {
      // Image : pas de `media_type`, l'URL suffit (JPEG uniquement côté Meta).
      params.image_url = input.mediaUrl;
    }
    if (input.caption) params.caption = input.caption;

    const payload = await postGraph(`/${input.providerAccountId}/media`, input.accessToken, params);
    const containerId = payload.id;
    if (typeof containerId !== "string" && typeof containerId !== "number") {
      throw new SocialPublishError("container_missing");
    }
    return String(containerId);
  },

  async containerStatus({ accessToken, containerId }): Promise<ContainerStatus> {
    const url = new URL(`${GRAPH_API}/${containerId}`);
    url.searchParams.set("fields", "status_code");
    url.searchParams.set("access_token", accessToken);

    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new SocialPublishError(
        `http_${response.status}`,
        `instagram container: HTTP ${response.status} ${await metaErrorCode(response)}`,
      );
    }
    const payload = unwrap<ContainerStatusPayload>(await response.json());
    return normalizeContainerStatus(payload.status_code);
  },

  async publishContainer({ accessToken, providerAccountId, containerId }) {
    const payload = await postGraph(`/${providerAccountId}/media_publish`, accessToken, {
      creation_id: containerId,
    });
    const mediaId = payload.id;
    if (typeof mediaId !== "string" && typeof mediaId !== "number") {
      throw new SocialPublishError("media_id_missing");
    }
    return { providerMediaId: String(mediaId) };
  },

  /** Best effort : l'absence de permalien ne remet pas en cause la publication. */
  async fetchPermalink({ accessToken, providerMediaId }) {
    const url = new URL(`${GRAPH_API}/${providerMediaId}`);
    url.searchParams.set("fields", "permalink");
    url.searchParams.set("access_token", accessToken);
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) return null;
    const payload = unwrap<{ permalink?: string }>(await response.json());
    return payload.permalink ?? null;
  },

  /** Quota imposé par Instagram — 100 publications / 24 h glissantes. */
  async remoteQuota({ accessToken, providerAccountId }) {
    const url = new URL(`${GRAPH_API}/${providerAccountId}/content_publishing_limit`);
    url.searchParams.set("fields", "quota_usage,config");
    url.searchParams.set("access_token", accessToken);
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) return null;
    const payload = unwrap<{ quota_usage?: number; config?: { quota_total?: number } }>(
      await response.json(),
    );
    if (typeof payload.quota_usage !== "number") return null;
    return { used: payload.quota_usage, limit: payload.config?.quota_total ?? 100 };
  },
};

export const instagramProvider: SocialProvider = {
  platform: "instagram",
  usesPkce: false,
  refreshUsesAccessToken: true,

  buildAuthUrl({ state, redirectUri }) {
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", appId());
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    // Scopes séparés par des virgules (documentation Business Login).
    url.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode({ code, redirectUri }) {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: appId(),
        client_secret: appSecret(),
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code: stripCodeFragment(code),
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`instagram token: HTTP ${response.status} ${await metaErrorCode(response)}`);
    }

    const short = unwrap<{ access_token?: string; user_id?: string | number; permissions?: string }>(
      await response.json(),
    );
    if (!short.access_token) {
      throw new Error("instagram token: réponse sans access_token");
    }

    // `permissions` reflète ce que l'utilisateur a RÉELLEMENT accordé : on le
    // conserve tel quel plutôt que de présumer que tout a été accepté.
    const granted = short.permissions
      ? short.permissions.split(",").map((scope) => scope.trim()).filter(Boolean)
      : INSTAGRAM_SCOPES;

    // Le token court vaut 1 heure : il est immédiatement converti en token
    // longue durée, seul jeton conservé dans Vault.
    return exchangeForLongLived(short.access_token, granted);
  },

  async fetchIdentity(accessToken): Promise<SocialIdentity> {
    const request = async (fields: string): Promise<Response> => {
      const url = new URL(ME_ENDPOINT);
      url.searchParams.set("fields", fields);
      url.searchParams.set("access_token", accessToken);
      return fetch(url, { method: "GET" });
    };

    let response = await request(PROFILE_FIELDS_RICH);
    if (response.status === 400) {
      // Champ non supporté par cette configuration : repli sur le jeu
      // strictement documenté, la connexion ne doit pas échouer pour un avatar.
      response = await request(PROFILE_FIELDS_MINIMAL);
    }
    if (!response.ok) {
      throw new Error(`instagram me: HTTP ${response.status} ${await metaErrorCode(response)}`);
    }

    const me = unwrap<{
      user_id?: string | number;
      id?: string | number;
      username?: string;
      name?: string;
      profile_picture_url?: string;
    }>(await response.json());

    const providerAccountId = me.user_id ?? me.id;
    if (providerAccountId === undefined || providerAccountId === null || providerAccountId === "") {
      throw new Error("instagram me: user_id absent");
    }

    return {
      providerAccountId: String(providerAccountId),
      // `username` est l'identité publique Instagram : plus parlant que `name`.
      displayName: me.username ?? me.name ?? null,
      avatarUrl: me.profile_picture_url ?? null,
    };
  },

  /**
   * `ig_refresh_token`. ATTENTION : l'argument est l'ACCESS TOKEN longue durée
   * courant (Instagram n'a pas de refresh token distinct) — cf.
   * `refreshUsesAccessToken`. Précondition officielle : token âgé d'au moins
   * 24 h et encore valide.
   */
  async refresh(longLivedAccessToken) {
    const url = new URL(REFRESH_ENDPOINT);
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", longLivedAccessToken);

    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(`instagram refresh: HTTP ${response.status} ${await metaErrorCode(response)}`);
    }
    return toTokenSet((await response.json()) as LongLivedPayload, INSTAGRAM_SCOPES);
  },

  // revoke : volontairement absent, aucun endpoint officiel pour cette
  // configuration. La notice ci-dessous est affichée à la déconnexion pour ne
  // pas laisser croire que l'autorisation Instagram a été retirée.
  revokeNotice: INSTAGRAM_REVOKE_NOTICE,

  publisher: instagramPublisher,
};
