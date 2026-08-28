/**
 * Classification des échecs d'envoi.
 *
 * Module pur, sans `server-only` : il ne lit ni environnement ni réseau, et
 * mérite d'être testé seul. C'est le même parti que `social/failure.ts`, pour
 * la même raison — la règle qui décide de réessayer est trop conséquente pour
 * vivre au milieu d'un appel HTTP.
 *
 * LA QUESTION QU'IL TRANCHE. Réessayer un échec DÉFINITIF ne le répare pas :
 * cela retarde le message d'erreur, consomme le quota, et peut expédier deux
 * fois si la première tentative avait en réalité abouti. Ne pas réessayer un
 * échec PASSAGER perd un courriel pour une coupure d'une seconde.
 *
 * La règle est donc volontairement conservatrice : on ne réessaie que sur des
 * signaux qui, par nature, ne dépendent pas de ce qu'on a envoyé.
 */

export type EmailFailureCode =
  /** Réseau injoignable, connexion coupée. */
  | "network"
  /** La requête a dépassé le délai imparti. */
  | "timeout"
  /** Panne côté Scaleway (5xx). */
  | "provider_unavailable"
  /** Débit dépassé (429). */
  | "rate_limited"
  /** Clé absente, invalide ou révoquée (401, 403). */
  | "unauthorized"
  /** Message refusé : adresse invalide, domaine non authentifié, quota (4xx). */
  | "rejected"
  /** Réponse inattendue, non classable. */
  | "unknown";

/**
 * Faut-il réessayer ?
 *
 * `unauthorized` est délibérément ABSENT : une clé invalide le restera à la
 * milliseconde suivante, et insister ne ferait que retarder le diagnostic.
 * `rejected` l'est aussi : une adresse mal formée ou un domaine non
 * authentifié ne se répare pas en réessayant — c'est précisément le cas où
 * POSTYNC doit se rabattre sur le lien à copier plutôt que d'insister.
 */
export function isRetryable(code: EmailFailureCode): boolean {
  return (
    code === "network" ||
    code === "timeout" ||
    code === "provider_unavailable" ||
    code === "rate_limited"
  );
}

/** Classe une réponse HTTP de Scaleway TEM. */
export function classifyHttpStatus(status: number): EmailFailureCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  if (status >= 400) return "rejected";
  return "unknown";
}

/**
 * Classe une exception levée par `fetch`.
 *
 * `AbortSignal.timeout()` lève une `TimeoutError` ; une coupure réseau lève
 * un `TypeError` (« fetch failed »). Les distinguer a un intérêt pratique :
 * un délai dépassé peut signifier que le message est PARTI quand même, ce
 * qu'une coupure à l'établissement de la connexion ne signifie pas.
 */
export function classifyThrown(error: unknown): EmailFailureCode {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "timeout";
    }
    if (error.name === "TypeError") {
      return "network";
    }
  }
  return "unknown";
}

/** Message destiné à l'utilisateur. Aucun détail technique n'y transparaît. */
export function userMessageFor(code: EmailFailureCode): string {
  switch (code) {
    case "rejected":
      return "Cette adresse e-mail a été refusée par le service d'envoi.";
    case "rate_limited":
      return "Trop d'e-mails envoyés à la suite. Patientez quelques minutes.";
    default:
      return "L'e-mail n'a pas pu être envoyé.";
  }
}
