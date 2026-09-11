/**
 * États des Server Actions de la médiathèque.
 *
 * Ces constantes vivent HORS du fichier `"use server"` : un tel module ne
 * peut exporter que des fonctions asynchrones. Même séparation que pour les
 * comptes sociaux (`social/action-state.ts`).
 */

export type UploadTicketState = {
  error: string | null;
  /**
   * Délivré par le serveur : où et quoi téléverser.
   *
   * `storagePath` accompagne l'URL signée parce que le transport REPRENABLE
   * n'utilise pas d'URL signée — il désigne l'objet par son chemin, que seul
   * le serveur a le droit de choisir. Le chemin n'est pas un secret : la
   * politique `media_resumable_insert` borne de toute façon l'écriture au
   * dossier du workspace de l'utilisateur.
   */
  ticket: { assetId: string; storagePath: string; uploadUrl: string } | null;
};

export const IDLE_UPLOAD_TICKET: UploadTicketState = { error: null, ticket: null };

export type MediaActionState = { error: string | null; notice: string | null };

export const IDLE_MEDIA_ACTION: MediaActionState = { error: null, notice: null };
