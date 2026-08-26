import "server-only";

import type { SocialIdentity, SocialProvider, TokenSet } from "./types";

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
const LONG_LIVED_ENDPOINT = `${GRAPH_HOST}/access_token`;
const REFRESH_ENDPOINT = `${GRAPH_HOST}/refresh_access_token`;
const ME_ENDPOINT = `${GRAPH_HOST}/me`;

/** Périmètre C8.4a : identité seulement. */
export const INSTAGRAM_SCOPES = ["instagram_business_basic"];

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
};
