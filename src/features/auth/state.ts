/**
 * État partagé entre les Server Actions d'authentification et les formulaires.
 *
 * Ce module est volontairement séparé de `actions.ts` : un fichier marqué
 * `"use server"` ne peut exporter que des fonctions asynchrones, pas des
 * constantes.
 */

/**
 * Champs du formulaire d'inscription que le serveur peut renvoyer au client
 * après une erreur, pour éviter à l'utilisateur de tout ressaisir.
 *
 * RÈGLE DE SÉCURITÉ : ce type ne doit JAMAIS contenir de mot de passe ni de
 * confirmation de mot de passe. Tout ce qui est placé ici transite vers le
 * navigateur dans la réponse de la Server Action.
 */
export type SignupPreservedValues = {
  displayName: string;
  email: string;
};

export type AuthFormState = {
  error: string | null;
  notice: string | null;
  /** Valeurs non sensibles à réinjecter dans le formulaire (inscription). */
  values?: SignupPreservedValues;
};

export const EMPTY_AUTH_STATE: AuthFormState = { error: null, notice: null };
