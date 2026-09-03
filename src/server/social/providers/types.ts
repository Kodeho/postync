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

/**
 * Publication — types communs.
 *
 * Séparation volontaire : le provider n'expose que des APPELS distants
 * (créer un conteneur, lire son statut, publier). Toute l'ORCHESTRATION
 * (autorisation, quota, attente, persistance, reprise) vit dans
 * `src/server/social/publish.ts`. Un provider ne connaît ni la base, ni les
 * workspaces, ni les plans.
 */

export type PublishMediaKind = "reel" | "image";

export type CreateContainerInput = {
  accessToken: string;
  providerAccountId: string;
  mediaKind: PublishMediaKind;
  /** URL PUBLIQUE du média : Instagram ne prend pas d'upload direct. */
  mediaUrl: string;
  caption: string | null;
  /** Image de couverture d'un Reel (optionnelle). */
  coverUrl?: string | null;
  /** Reel également visible dans le fil, quand la plateforme le permet. */
  shareToFeed?: boolean;
  /**
   * Durée mesurée du média, en secondes, quand elle est connue.
   *
   * Les règles statiques de `media/rules.ts` ne suffisent pas partout :
   * TikTok expose une durée maximale PAR CRÉATEUR (`creator_info`), qu'aucune
   * table figée ne peut anticiper. Le provider a donc besoin de la mesure
   * pour arbitrer lui-même. Optionnel : les providers qui n'en ont pas
   * l'usage l'ignorent, et rien ne change pour eux.
   */
  durationSeconds?: number | null;
  /**
   * Visibilité demandée, dans le vocabulaire de la PLATEFORME.
   *
   * Aucun réseau implémenté avant TikTok n'en propose le choix à la
   * publication. Le champ reste donc facultatif, et chaque provider décide
   * de son défaut — TikTok l'impose même à `SELF_ONLY` tant que son client
   * n'est pas audité, quelle que soit la valeur reçue ici.
   */
  privacyLevel?: string | null;
  /**
   * Titre du média, distinct de la légende.
   *
   * Seul YouTube en exige un : `snippet.title` est obligatoire pour
   * `videos.insert`, et c'est l'élément principal de la page vidéo. Les
   * autres réseaux n'ont pas de notion équivalente — chez eux, le texte est
   * la légende — et ignorent donc ce champ.
   */
  title?: string | null;
  /**
   * Taille en octets du média, quand elle est connue. YouTube l'exige AVANT
   * le premier octet (`X-Upload-Content-Length`) : sans elle, la session
   * résumable ne peut pas être ouverte.
   */
  byteSize?: number | null;
  /**
   * Déclaration `selfDeclaredMadeForKids` de YouTube, faite PAR L'UTILISATEUR.
   *
   * Facultatif au niveau du type parce que les autres réseaux n'en ont pas la
   * notion. Chez YouTube en revanche l'absence est une erreur, pas un `false` :
   * les Developer Policies III.J imposent de déclarer `true` un contenu
   * destiné aux enfants, et cette déclaration engage l'utilisateur.
   */
  madeForKids?: boolean | null;
};

/**
 * Statut d'un conteneur distant, normalisé.
 * `ready` : publiable · `processing` : encore en traitement ·
 * `failed` : traitement échoué · `expired` : conteneur périmé ·
 * `published` : déjà publié.
 */
export type ContainerStatus = "ready" | "processing" | "failed" | "expired" | "published";

/**
 * Échec de publication portant un code court et stable, destiné à être
 * enregistré en base et présenté à l'utilisateur. Ne doit JAMAIS transporter
 * de token ni de payload brut de la plateforme.
 */
export class SocialPublishError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SocialPublishError";
  }
}

export interface SocialPublisher {
  /** Scopes supplémentaires exigés pour publier (contrôlés avant tout appel). */
  requiredScopes: string[];
  /** Types de médias réellement supportés par cette implémentation. */
  supportedMediaKinds: readonly PublishMediaKind[];
  createContainer(input: CreateContainerInput): Promise<string>;
  containerStatus(input: { accessToken: string; containerId: string }): Promise<ContainerStatus>;
  publishContainer(input: {
    accessToken: string;
    providerAccountId: string;
    containerId: string;
    /**
     * Légende. Certaines plateformes la portent sur le CONTENEUR (Instagram),
     * d'autres au moment de la publication (Facebook : `description` de la
     * phase `finish`). Elle est donc fournie aux deux étapes ; à chaque
     * provider d'utiliser celle qui le concerne.
     */
    caption?: string | null;
  }): Promise<{ providerMediaId: string }>;
  /**
   * Poursuite d'un transfert d'octets déjà entamé.
   *
   * Présent UNIQUEMENT chez les plateformes qui ne savent pas aller chercher
   * le média elles-mêmes. Instagram, Facebook et TikTok reçoivent une URL et
   * tirent le fichier ; YouTube, lui, n'accepte aucune URL distante — c'est
   * POSTYNC qui pousse les octets, et un fichier de 300 Mo ne tient pas dans
   * une seule invocation.
   *
   * L'appelant fournit une échéance : la méthode envoie ce qu'elle peut
   * avant, puis rend la main. Ce qui reste sera repris au réveil suivant, à
   * l'octet près — jamais depuis le début. C'est ce qui rend le transfert
   * fractionné sûr : la session distante est la seule source de vérité sur ce
   * qui a déjà été reçu.
   */
  resumeTransfer?(input: {
    accessToken: string;
    /** Identifiant de session rendu par `createContainer`. */
    containerId: string;
    /** URL signée FRAÎCHE du média — celle de la création a pu expirer. */
    mediaUrl: string;
    /**
     * Instant (ms) au-delà duquel il faut rendre la main. L'appelant DOIT
     * accorder au moins le budget minimal annoncé par le provider : en deçà,
     * celui-ci lève plutôt que de rendre la main sans rien faire.
     */
    deadline: number;
    /**
     * Octets effectivement acceptés par la plateforme pendant cet appel. Zéro
     * est licite — session déjà complète, ou échéance atteinte — mais doit
     * rester OBSERVABLE : une reprise qui n'avance jamais est une panne, pas
     * un régime permanent.
     */
  }): Promise<{ pushedBytes: number }>;
  /** Lien public du média publié — best effort, jamais bloquant. */
  fetchPermalink?(input: { accessToken: string; providerMediaId: string }): Promise<string | null>;
  /** Quota de publication imposé par la PLATEFORME (distinct du plan POSTYNC). */
  remoteQuota?(input: {
    accessToken: string;
    providerAccountId: string;
  }): Promise<{ used: number; limit: number } | null>;
}

/**
 * Un actif publiable rattaché à une autorisation (une Page Facebook).
 *
 * `token` est le jeton PROPRE à l'actif : c'est lui qui sera conservé dans
 * Vault, jamais le jeton utilisateur qui a servi à l'obtenir.
 */
export type SocialAsset = {
  assetId: string;
  name: string;
  avatarUrl: string | null;
  token: string;
  /**
   * L'utilisateur peut-il réellement publier sur cet actif ? Une Page qu'il
   * ne fait qu'analyser ne doit pas être proposée à la connexion.
   */
  canPublish: boolean;
};

export interface SocialAssetSelector {
  /** Actifs administrés par l'utilisateur, avec leur jeton dédié. */
  listAssets(userAccessToken: string): Promise<SocialAsset[]>;
}

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
  /**
   * Identité UNIQUE du compte autorisé (YouTube, TikTok, Instagram).
   * Absent pour les providers à actifs multiples, qui exposent `assets`.
   */
  fetchIdentity?(accessToken: string): Promise<SocialIdentity>;
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
  /**
   * Capacité de publication. Absente tant que la plateforme n'est pas
   * implémentée ou pas encore autorisée à publier.
   */
  publisher?: SocialPublisher;
  /**
   * Sélection d'actifs. Présent quand UNE autorisation donne accès à
   * PLUSIEURS comptes publiables (Pages Facebook). Le callback ne crée alors
   * aucune ligne : il met la connexion en attente et l'utilisateur choisit.
   */
  assets?: SocialAssetSelector;
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
