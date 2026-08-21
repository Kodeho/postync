import "server-only";

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
 *   - moindre privilège : `user.info.basic` uniquement (open_id,
 *     display_name, avatar). AUCUNE publication en C8 — `video.publish`
 *     viendra avec la Content Posting API et son audit.
 *
 * Contrainte officielle : redirect URIs HTTPS absolus (pas de localhost) →
 * le E2E s'effectue sur le déploiement de production.
 */

const AUTH_ENDPOINT = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/token/";
const REVOKE_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/revoke/";
const USER_INFO_ENDPOINT = "https://open.tiktokapis.com/v2/user/info/";

/** Périmètre C8.3 : identité seulement. */
export const TIKTOK_SCOPES = ["user.info.basic"];

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

/** Code d'erreur court d'une réponse TikTok (jamais le corps complet). */
async function tiktokErrorCode(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: string | { code?: string };
      error_description?: string;
    };
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.code ?? "";
  } catch {
    return "";
  }
}

type TikTokTokenPayload = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
  open_id?: string;
  error?: string;
};

function toTokenSet(payload: TikTokTokenPayload): TokenSet {
  if (!payload.access_token) {
    throw new Error(`réponse token sans access_token ${payload.error ?? ""}`.trim());
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
    if (!response.ok) {
      throw new Error(`tiktok token: HTTP ${response.status} ${await tiktokErrorCode(response)}`);
    }
    return toTokenSet((await response.json()) as TikTokTokenPayload);
  },

  async fetchIdentity(accessToken): Promise<SocialIdentity> {
    const url = new URL(USER_INFO_ENDPOINT);
    url.searchParams.set("fields", "open_id,union_id,display_name,avatar_url_100");
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`tiktok user/info: HTTP ${response.status} ${await tiktokErrorCode(response)}`);
    }
    const payload = (await response.json()) as {
      data?: { user?: { open_id?: string; display_name?: string; avatar_url_100?: string } };
      error?: { code?: string };
    };
    if (payload.error?.code && payload.error.code !== "ok") {
      throw new Error(`tiktok user/info: ${payload.error.code}`);
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
    if (!response.ok) {
      throw new Error(`tiktok refresh: HTTP ${response.status} ${await tiktokErrorCode(response)}`);
    }
    // Rotation : le refresh_token renvoyé peut être NOUVEAU — le TokenSet le
    // porte toujours, l'appelant remplace systématiquement l'ancien.
    return toTokenSet((await response.json()) as TikTokTokenPayload);
  },

  async revoke({ accessToken }) {
    // La révocation officielle porte sur l'access token.
    if (!accessToken) return;
    await postForm(REVOKE_ENDPOINT, {
      client_key: clientKey(),
      client_secret: clientSecret(),
      token: accessToken,
    });
  },
};
