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
};

export const IDLE_TEAM_ACTION: TeamActionState = {
  error: null,
  notice: null,
  invitationUrl: null,
};
