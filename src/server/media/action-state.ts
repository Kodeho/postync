/**
 * États des Server Actions de la médiathèque.
 *
 * Ces constantes vivent HORS du fichier `"use server"` : un tel module ne
 * peut exporter que des fonctions asynchrones. Même séparation que pour les
 * comptes sociaux (`social/action-state.ts`).
 */

export type UploadTicketState = {
  error: string | null;
  /** Délivré par le serveur : où et quoi téléverser. */
  ticket: { assetId: string; uploadUrl: string } | null;
};

export const IDLE_UPLOAD_TICKET: UploadTicketState = { error: null, ticket: null };

export type MediaActionState = { error: string | null; notice: string | null };

export const IDLE_MEDIA_ACTION: MediaActionState = { error: null, notice: null };
