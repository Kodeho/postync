import type { SocialPlatform } from "@/types/platform";

/**
 * Types et logique PURE des comptes sociaux (affichage, statuts, quotas) —
 * sans dépendance serveur, testable unitairement.
 */

export type SocialAccountStatus = "active" | "expired" | "revoked" | "error";

export type SocialAccountRow = {
  id: string;
  workspace_id: string;
  platform: SocialPlatform;
  provider_account_id: string;
  display_name: string | null;
  avatar_url: string | null;
  token_expires_at: string | null;
  refresh_expires_at: string | null;
  scopes: string[];
  status: SocialAccountStatus;
  status_detail: string | null;
  connected_at: string;
};

export const SOCIAL_STATUS_LABELS: Record<SocialAccountStatus, string> = {
  active: "Connecté",
  expired: "Expiré",
  revoked: "Accès révoqué",
  error: "Erreur",
};

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  youtube: "YouTube",
};

/**
 * Statut effectif à l'affichage : une ligne `active` dont l'access token est
 * expiré SANS refresh token possible est montrée « expirée » (le refresh à la
 * demande couvre le cas où un refresh token existe).
 */
export function effectiveStatus(
  account: Pick<SocialAccountRow, "status" | "token_expires_at" | "refresh_expires_at">,
  now: number = Date.now(),
): SocialAccountStatus {
  if (account.status !== "active") {
    return account.status;
  }
  const tokenExpired =
    account.token_expires_at !== null && new Date(account.token_expires_at).getTime() <= now;
  const refreshExpired =
    account.refresh_expires_at !== null && new Date(account.refresh_expires_at).getTime() <= now;
  if (refreshExpired || (tokenExpired && account.refresh_expires_at === null)) {
    // Plus aucun moyen de rafraîchir : reconnexion nécessaire.
    return "expired";
  }
  return "active";
}

/** Une reconnexion est proposée pour tout compte non « Connecté ». */
export function needsReconnect(status: SocialAccountStatus): boolean {
  return status !== "active";
}

/**
 * Peut-on connecter un compte SUPPLÉMENTAIRE ? Quota `socialAccounts` du plan
 * (C7), tous réseaux confondus. La reconnexion d'un compte existant n'est
 * jamais bloquée par le quota.
 */
export function canConnectMore(currentCount: number, quota: number): boolean {
  return currentCount < quota;
}

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------

export type SocialPublicationStatus = "pending" | "published" | "failed";

export type SocialPublicationRow = {
  id: string;
  workspace_id: string;
  social_account_id: string | null;
  platform: SocialPlatform;
  provider_account_id: string;
  media_kind: "reel" | "image";
  media_url: string;
  caption: string | null;
  container_id: string | null;
  provider_media_id: string | null;
  permalink: string | null;
  status: SocialPublicationStatus;
  status_detail: string | null;
  created_at: string;
  published_at: string | null;
};

export const PUBLICATION_STATUS_LABELS: Record<SocialPublicationStatus, string> = {
  pending: "En cours",
  published: "Publié",
  failed: "Échec",
};

export const MEDIA_KIND_LABELS: Record<"reel" | "image", string> = {
  reel: "Reel",
  image: "Image",
};

/** Une publication en cours reste reprenable tant qu'elle a un conteneur. */
export function canResume(
  publication: Pick<SocialPublicationRow, "status" | "container_id">,
): boolean {
  return publication.status === "pending" && Boolean(publication.container_id);
}

/**
 * Peut-on publier ce mois-ci ? Quota `publicationsPerMonth` du plan (C7),
 * publications abouties et en cours confondues.
 */
export function canPublishMore(currentCount: number, quota: number): boolean {
  return currentCount < quota;
}
