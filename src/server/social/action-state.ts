/** État renvoyé par les Server Actions des comptes sociaux. */
export type SocialActionState = { error: string | null };

export const IDLE_SOCIAL_ACTION: SocialActionState = { error: null };

/**
 * État de la publication. Contrairement à la déconnexion, le formulaire reste
 * monté après l'envoi : le résultat peut donc être rendu sur place.
 */
export type PublishActionState = {
  error: string | null;
  /**
   * `published` : en ligne · `pending` : traitement en cours côté plateforme
   * · `scheduled` : enregistrée pour une échéance future (C10.3).
   */
  status: "published" | "pending" | "scheduled" | null;
  permalink: string | null;
  /** Identifiant de la publication, nécessaire pour reprendre un `pending`. */
  publicationId: string | null;
  /** Échéance retenue, en ISO. Non nulle quand `status` vaut `scheduled`. */
  scheduledAt: string | null;
};

export const IDLE_PUBLISH_ACTION: PublishActionState = {
  error: null,
  status: null,
  permalink: null,
  publicationId: null,
  scheduledAt: null,
};
