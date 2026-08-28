/**
 * Ce qu'une demande de réinitialisation a le droit de dire (C15).
 *
 * Module séparé parce qu'un fichier `"use server"` ne peut exporter que des
 * fonctions asynchrones — et parce que cette règle mérite d'être lisible et
 * testée seule : c'est elle qui décide de ce qui sort du serveur.
 *
 * LA RÈGLE. Le formulaire « mot de passe oublié » est PUBLIC. Répondre
 * « compte inconnu », ou même laisser filtrer une erreur différente selon que
 * l'adresse existe ou non, en ferait un oracle : on énumère alors la clientèle
 * de POSTYNC adresse par adresse. La réponse est donc constante.
 *
 * L'UNIQUE EXCEPTION est la limite de débit. Elle ne dépend pas de l'adresse
 * saisie — elle est globale — et ne révèle donc rien. La taire aurait un coût
 * réel : la personne, croyant son courriel parti, attendrait un message que
 * Supabase a refusé d'envoyer, puis recommencerait, aggravant la limite.
 */

const CODES_DE_LIMITE = new Set([
  "over_email_send_rate_limit",
  "over_request_rate_limit",
]);

/**
 * L'erreur peut-elle être montrée à l'utilisateur ?
 *
 * `false` ne veut pas dire « ignorer » : l'appelant journalise toujours côté
 * serveur. Cela veut dire « ne pas en faire une réponse différente ».
 */
export function shouldDiscloseResetError(code: string | null | undefined): boolean {
  return typeof code === "string" && CODES_DE_LIMITE.has(code);
}
