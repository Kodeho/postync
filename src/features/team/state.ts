/**
 * États des formulaires d'équipe (C14).
 *
 * Module séparé : un fichier `"use server"` ne peut exporter que des fonctions
 * asynchrones.
 */
export type TeamActionState = {
  error: string | null;
  notice: string | null;
  /**
   * Lien d'invitation, à remettre à la personne conviée.
   *
   * Il n'est affiché qu'UNE FOIS, juste après la création : le jeton n'est pas
   * conservé, seule son empreinte l'est. Renvoyer l'invitation produit un
   * nouveau lien et invalide l'ancien.
   */
  invitationUrl: string | null;
  /**
   * Invitation que ce lien ouvre.
   *
   * Sert à savoir si le lien affiché est encore VIVANT : annuler l'invitation,
   * ou la renvoyer, le rend inutilisable, et un écran qui continue de le
   * présenter sous « copiez-le maintenant » invite à transmettre un lien mort.
   */
  invitationId: string | null;
};

export const IDLE_TEAM_ACTION: TeamActionState = {
  error: null,
  notice: null,
  invitationUrl: null,
  invitationId: null,
};
