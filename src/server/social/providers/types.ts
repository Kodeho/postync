import "server-only";

import type { SocialPlatform } from "@/types/platform";

/**
 * Interface commune des fournisseurs OAuth (implémentations en C8.2+).
 *
 * Contrat de sécurité : les tokens ne transitent que dans la mémoire du
 * serveur, entre l'API du provider et Vault. Jamais de log, jamais de retour
 * au client, jamais d'URL POSTYNC.
 */

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  /** Date ISO d'expiration de l'access token, null = non expirant. */
  expiresAt: string | null;
  /** Date ISO d'expiration du refresh token (TikTok), null sinon. */
  refreshExpiresAt: string | null;
  scopes: string[];
};

/**
 * Le compte authentifié ne possède pas le profil requis sur la plateforme
 * (ex. compte Google sans chaîne YouTube — code Google `youtubeSignupRequired`).
 * Cas utilisateur légitime, distinct d'un échec technique.
 */
export class SocialIdentityUnavailableError extends Error {}

export type SocialIdentity = {
  providerAccountId: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export interface SocialProvider {
  platform: SocialPlatform;
  /** PKCE S256 exigé/supporté par ce provider. */
  usesPkce: boolean;
  buildAuthUrl(input: {
    state: string;
    codeChallenge: string | null;
    redirectUri: string;
  }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string | null;
    redirectUri: string;
  }): Promise<TokenSet>;
  fetchIdentity(accessToken: string): Promise<SocialIdentity>;
  /**
   * Rafraîchissement du jeton. L'argument est normalement le REFRESH TOKEN,
   * sauf pour les providers qui n'en délivrent pas de distinct et rafraîchissent
   * le jeton avec lui-même (Instagram) : voir `refreshUsesAccessToken`.
   */
  refresh?(token: string): Promise<TokenSet>;
  /**
   * `true` quand `refresh()` attend l'ACCESS TOKEN courant et non un refresh
   * token (cas Instagram : `ig_refresh_token` prolonge le jeton longue durée
   * lui-même, aucun refresh token n'existe). L'appelant doit alors lire
   * `access_token_id` et non `refresh_token_id`.
   */
  refreshUsesAccessToken?: boolean;
  /** Révocation best effort côté plateforme lors de la déconnexion. */
  revoke?(tokens: { accessToken: string | null; refreshToken: string | null }): Promise<void>;
  /**
   * Message affiché après une déconnexion quand la plateforme n'expose AUCUN
   * endpoint de révocation (`revoke` absent) : l'utilisateur doit alors retirer
   * l'autorisation lui-même. Ne pas laisser croire que l'accès est révoqué.
   */
  revokeNotice?: string;
}

/**
 * Registre des providers. Vide en C8.1 : chaque plateforme est ajoutée par sa
 * sous-étape (C8.2 YouTube, C8.3 TikTok, C8.4 Meta) après vérification de la
 * documentation officielle — les scopes ne sont pas figés ici.
 */
const REGISTRY = new Map<SocialPlatform, SocialProvider>();

export function registerProvider(provider: SocialProvider): void {
  REGISTRY.set(provider.platform, provider);
}

export function getProvider(platform: SocialPlatform): SocialProvider | null {
  return REGISTRY.get(platform) ?? null;
}

export function isProviderAvailable(platform: SocialPlatform): boolean {
  return REGISTRY.has(platform);
}
