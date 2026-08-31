import "server-only";

import { TIKTOK_PUBLISH_SCOPE, tiktokPublisher } from "./tiktok-publisher";
import type { SocialIdentity, SocialProvider, TokenSet } from "./types";

/**
 * Provider TikTok (Login Kit Web, OAuth v2).
 *
 * Implémentation strictement alignée sur la documentation officielle
 * TikTok for Developers (login-kit-web, oauth-user-access-token-management,
 * tiktok-api-v2-get-user-info — vérifiée le 2026-08-21) :
 *   - autorisation : https://www.tiktok.com/v2/auth/authorize/ avec
 *     `client_key`, scopes séparés par des VIRGULES, `state` ;
 *   - `code_verifier` PKCE « required for mobile and desktop app only » →
 *     application web : non utilisé (`usesPkce: false`) ; le CSRF est couvert
 *     par notre `state` à usage unique ;
 *   - échange/refresh : POST open.tiktokapis.com/v2/oauth/token/ (form) avec
 *     `client_key` + `client_secret` ; access token 24 h, refresh token
 *     365 jours ; LE REFRESH PEUT RENVOYER UN NOUVEAU refresh_token
 *     (rotation obligatoire, prise en charge par l'appelant) ;
 *   - révocation : POST /v2/oauth/revoke/ (access token + identifiants) ;
 *   - scopes : `user.info.basic` (open_id, display_name, avatar) et
 *     `video.publish` (Content Posting API). La publication elle-même vit
 *     dans `tiktok-publisher.ts` : ce module ne connaît que l'autorisation.
 *
 * Contrainte officielle : redirect URIs HTTPS absolus (pas de localhost) →
 * le E2E s'effectue sur le déploiement de production.
 */

const AUTH_ENDPOINT = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/token/";
const REVOKE_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/revoke/";
const USER_INFO_ENDPOINT = "https://open.tiktokapis.com/v2/user/info/";

/** Identité (C8.3). */
export const TIKTOK_BASIC_SCOPE = "user.info.basic";

/**
 * Scopes demandés à l'autorisation.
 *
 * `video.publish` accompagne l'identité depuis l'étape publication : le
 * demander à la connexion évite un second passage par le consentement. Un
 * compte connecté AVANT cet ajout ne le porte pas — `publish.ts` compare les
 * scopes RÉELLEMENT accordés et réclame une reconnexion, plutôt que de tenter
 * un appel voué au refus `scope_not_authorized`.
 *
 * Contrepartie assumée : l'écran de consentement TikTok annonce désormais la
 * publication de vidéos. C'est exact, c'est le produit, et le taire aurait
 * été le vrai problème.
 */
export const TIKTOK_SCOPES = [TIKTOK_BASIC_SCOPE, TIKTOK_PUBLISH_SCOPE];

function clientKey(): string {
  return process.env.TIKTOK_CLIENT_KEY ?? "";
}
function clientSecret(): string {
  return process.env.TIKTOK_CLIENT_SECRET ?? "";
}

export function isTikTokConfigured(): boolean {
  return clientKey().length > 0 && clientSecret().length > 0;
}

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

/**
 * Lecture d'une réponse du serveur d'autorisation TikTok.
 *
 * Constaté en conditions réelles le 2026-08-27 : TikTok répond **HTTP 200**
 * avec un corps `{"error":"invalid_client","error_description":"Client key or
 * secret is incorrect."}`. Ne se fier qu'à `response.ok` laisse donc passer
 * l'erreur, qui ne se manifeste plus loin que par un access_token absent — un
 * symptôme, pas la cause. On lit le champ `error` documenté, quel que soit le
 * statut HTTP.
 *
 * Seul le CODE sort d'ici, jamais `error_description` ni le corps : le code
 * suffisait à identifier la panne du 2026-08-27 (`invalid_client` = paire
 * clé/secret refusée), et la règle « pas de corps brut » reste entière.
 *
 * Renvoie `null` quand le corps est vide : la révocation réussie n'en a pas.
 */
async function readOAuthPayload(
  response: Response,
  contexte: string,
): Promise<TikTokTokenPayload | null> {
  let payload: TikTokTokenPayload | null = null;
  try {
    payload = (await response.json()) as TikTokTokenPayload;
  } catch {
    payload = null;
  }

  const code = payload?.error;
  if (typeof code === "string" && code.length > 0 && code !== "ok") {
    throw new Error(`tiktok ${contexte}: ${code}`);
  }
  if (!response.ok) {
    throw new Error(`tiktok ${contexte}: HTTP ${response.status}`);
  }
  return payload;
}

type TikTokTokenPayload = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
  open_id?: string;
  error?: string;
  error_description?: string;
};

function toTokenSet(payload: TikTokTokenPayload): TokenSet {
  if (!payload.access_token) {
    throw new Error("réponse token sans access_token");
  }
  const now = Date.now();
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt:
      typeof payload.expires_in === "number"
        ? new Date(now + payload.expires_in * 1000).toISOString()
        : null,
    refreshExpiresAt:
      typeof payload.refresh_expires_in === "number"
        ? new Date(now + payload.refresh_expires_in * 1000).toISOString()
        : null,
    // TikTok sépare les scopes par des virgules.
    scopes: payload.scope ? payload.scope.split(",") : TIKTOK_SCOPES,
  };
}

export const tiktokProvider: SocialProvider = {
  platform: "tiktok",
  usesPkce: false,

  buildAuthUrl({ state, redirectUri }) {
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_key", clientKey());
    url.searchParams.set("scope", TIKTOK_SCOPES.join(","));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode({ code, redirectUri }) {
    const response = await postForm(TOKEN_ENDPOINT, {
      client_key: clientKey(),
      client_secret: clientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    return toTokenSet((await readOAuthPayload(response, "token")) ?? {});
  },

  async fetchIdentity(accessToken): Promise<SocialIdentity> {
    const url = new URL(USER_INFO_ENDPOINT);
    url.searchParams.set("fields", "open_id,union_id,display_name,avatar_url_100");
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const payload = (await response.json().catch(() => ({}))) as {
      data?: { user?: { open_id?: string; display_name?: string; avatar_url_100?: string } };
      error?: { code?: string };
    };
    // Ici l'erreur est un OBJET (`error.code`), pas une chaîne : forme propre
    // aux API de données, distincte de celle du serveur d'autorisation.
    if (payload.error?.code && payload.error.code !== "ok") {
      throw new Error(`tiktok user/info: ${payload.error.code}`);
    }
    if (!response.ok) {
      throw new Error(`tiktok user/info: HTTP ${response.status}`);
    }
    const user = payload.data?.user;
    if (!user?.open_id) {
      throw new Error("tiktok user/info: open_id absent");
    }
    return {
      providerAccountId: user.open_id,
      displayName: user.display_name ?? null,
      avatarUrl: user.avatar_url_100 ?? null,
    };
  },

  async refresh(refreshToken) {
    const response = await postForm(TOKEN_ENDPOINT, {
      client_key: clientKey(),
      client_secret: clientSecret(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    // Rotation : le refresh_token renvoyé peut être NOUVEAU — le TokenSet le
    // porte toujours, l'appelant remplace systématiquement l'ancien.
    return toTokenSet((await readOAuthPayload(response, "refresh")) ?? {});
  },

  async revoke({ accessToken }) {
    // La révocation officielle porte sur l'access token.
    if (!accessToken) return;
    const response = await postForm(REVOKE_ENDPOINT, {
      client_key: clientKey(),
      client_secret: clientSecret(),
      token: accessToken,
    });
    // Même piège qu'à l'échange. L'appelant traite l'échec de révocation comme
    // non bloquant — encore faut-il qu'il puisse le VOIR.
    await readOAuthPayload(response, "revoke");
  },

  publisher: tiktokPublisher,
};
