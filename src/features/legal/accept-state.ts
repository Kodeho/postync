/**
 * État renvoyé par l'action de réacceptation.
 *
 * CE FICHIER EXISTE POUR UNE RAISON PRÉCISE. Un module marqué `"use server"`
 * ne peut exporter QUE des fonctions asynchrones : Next.js transforme chaque
 * export en point d'entrée appelable depuis le client, et un objet n'en est
 * pas un. La règle n'est pas vérifiée à la compilation — elle l'est à
 * l'exécution, quand le module est chargé.
 *
 * La première version exportait `IDLE_LEGAL_ACCEPT` depuis l'action elle-même.
 * Le build passait, les tests aussi, et la production rendait `500` au premier
 * envoi du formulaire :
 *
 *     A "use server" file can only export async functions, found object.
 *
 * Le reste du dépôt sépare déjà état et action — `social/action-state.ts` —
 * et ce fichier suit ce motif.
 */

export type LegalAcceptState = { error: string | null };

export const IDLE_LEGAL_ACCEPT: LegalAcceptState = { error: null };
