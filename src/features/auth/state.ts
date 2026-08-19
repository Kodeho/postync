/**
 * État partagé entre les Server Actions d'authentification et les formulaires.
 *
 * Ce module est volontairement séparé de `actions.ts` : un fichier marqué
 * `"use server"` ne peut exporter que des fonctions asynchrones, pas des
 * constantes.
 */
export type AuthFormState = {
  error: string | null;
  notice: string | null;
};

export const EMPTY_AUTH_STATE: AuthFormState = { error: null, notice: null };
