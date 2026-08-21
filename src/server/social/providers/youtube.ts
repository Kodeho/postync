import "server-only";

import { SocialIdentityUnavailableError, type SocialIdentity, type SocialProvider, type TokenSet } from "./types";

/**
 * Provider YouTube (Google OAuth 2.0, flux « web server application »).
 *
 * Implémentation strictement alignée sur la documentation officielle
 * (developers.google.com/identity/protocols/oauth2/web-server, vérifiée le
 * 2026-08-20) :
 *   - client confidentiel : `client_secret` à l'échange et au refresh ;
 *     PKCE n'est pas documenté pour ce flux (le CSRF est couvert par notre
 *     `state` à usage unique) → `usesPkce: false` ;
 *   - `access_type=offline` + `prompt=consent` : refresh token garanti ;
 *   - `include_granted_scopes=true` : autorisation incrémentale — la future
 *     étape publication ajoutera `youtube.upload` sans re-demander le reste ;
 *   - moindre privilège : `youtube.readonly` suffit pour identifier la
 *     chaîne (`channels.list?mine=true`). AUCUNE publication en C8.
 *
 * Attention (officiel) : consent screen en statut « Testing » ⇒ refresh
 * tokens expirés au bout de 7 jours ; la reconnexion C8.1 couvre ce cas.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels";

/** Périmètre C8.2 : lecture seule. `youtube.upload` viendra en incrémental. */
export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];

function clientId(): string {
  return process.env.GOOGLE_CLIENT_ID ?? "";
}
function clientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET ?? "";
}

export function isYouTubeConfigured(): boolean {
  return clientId().length > 0 && clientSecret().length > 0;
}

function toTokenSet(payload: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}): TokenSet {
  if (!payload.access_token) {
    throw new Error("réponse token sans access_token");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt:
      typeof payload.expires_in === "number"
        ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
        : null,
    refreshExpiresAt: null, // non communiqué par Google (révocation possible côté compte)
    scopes: payload.scope ? payload.scope.split(" ") : YOUTUBE_SCOPES,
  };
}

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

/** Code d'erreur court d'une réponse Google (jamais le corps complet). */
async function googleErrorCode(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: string | { status?: string; errors?: { reason?: string }[] };
    };
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.errors?.[0]?.reason ?? payload.error?.status ?? "";
  } catch {
    return "";
  }
}

export const youtubeProvider: SocialProvider = {
  platform: "youtube",
  usesPkce: false,

  buildAuthUrl({ state, redirectUri }) {
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", clientId());
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    return url.toString();
  },

  async exchangeCode({ code, redirectUri }) {
    const response = await postForm(TOKEN_ENDPOINT, {
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    if (!response.ok) {
      throw new Error(`google token: HTTP ${response.status} ${await googleErrorCode(response)}`);
    }
    return toTokenSet(await response.json());
  },

  async fetchIdentity(accessToken): Promise<SocialIdentity> {
    const url = new URL(CHANNELS_ENDPOINT);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const code = await googleErrorCode(response);
      if (code === "youtubeSignupRequired") {
        // Compte Google sans chaîne YouTube : cas utilisateur, pas technique.
        throw new SocialIdentityUnavailableError("youtubeSignupRequired");
      }
      throw new Error(`youtube channels: HTTP ${response.status} ${code}`);
    }
    const payload = (await response.json()) as {
      items?: { id: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }[];
    };
    const channel = payload.items?.[0];
    if (!channel?.id) {
      throw new SocialIdentityUnavailableError("aucune chaîne YouTube sur ce compte Google");
    }
    return {
      providerAccountId: channel.id,
      displayName: channel.snippet?.title ?? null,
      avatarUrl: channel.snippet?.thumbnails?.default?.url ?? null,
    };
  },

  async refresh(refreshToken) {
    const response = await postForm(TOKEN_ENDPOINT, {
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: "refresh_token",
    });
    if (!response.ok) {
      throw new Error(`google refresh: HTTP ${response.status} ${await googleErrorCode(response)}`);
    }
    const tokens = toTokenSet(await response.json());
    // Google ne renvoie généralement PAS de nouveau refresh token : l'appelant
    // conserve l'existant quand `refreshToken` est null.
    return tokens;
  },

  async revoke({ refreshToken, accessToken }) {
    // Révoquer le refresh token révoque aussi les access tokens associés.
    const token = refreshToken ?? accessToken;
    if (!token) return;
    await postForm(REVOKE_ENDPOINT, { token });
  },
};
