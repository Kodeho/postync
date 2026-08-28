/**
 * Destination de retour après authentification (C14).
 *
 * POURQUOI CE MODULE EXISTE. Une invitation reçue par quelqu'un qui n'est pas
 * connecté doit le ramener SUR L'INVITATION après connexion ou inscription.
 * Sans cela, il atterrit sur l'accueil et son lien est perdu.
 *
 * POURQUOI IL EST SI STRICT. Rediriger vers une valeur venue de l'URL est la
 * définition même d'une redirection ouverte : un lien
 * `…/login?next=https://exemple-malveillant` renverrait l'utilisateur sur un
 * site tiers juste après qu'il ait saisi son mot de passe — le moment idéal
 * pour lui présenter une fausse page de connexion.
 *
 * La règle est donc une LISTE BLANCHE de forme : un chemin interne, absolu, et
 * rien d'autre. Tout le reste retombe silencieusement sur l'accueil.
 */

export const DEFAULT_RETURN_PATH = "/app";

/** Un schéma (`javascript:`, `https:`…) n'a rien à faire dans un chemin. */
const SCHEMA = /^\/[a-z][a-z0-9+.-]*:/i;

/**
 * Caractères de contrôle, vérifiés par code plutôt que par expression
 * régulière : ils permettent d'injecter un en-tête dans une réponse HTTP, et
 * les écrire littéralement dans une regex rend le fichier illisible.
 */
function contientUnCaractereDeControle(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function safeReturnPath(
  value: string | null | undefined,
  fallback: string = DEFAULT_RETURN_PATH,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    return fallback;
  }
  // Un chemin interne commence par `/`…
  if (!value.startsWith("/")) return fallback;
  // …mais `//exemple.com` est une URL protocole-relative, donc EXTERNE.
  if (value.startsWith("//")) return fallback;
  // `/\exemple.com` est interprété comme `//` par certains navigateurs.
  if (value.startsWith("/\\")) return fallback;
  if (SCHEMA.test(value)) return fallback;
  if (contientUnCaractereDeControle(value)) return fallback;

  return value;
}
