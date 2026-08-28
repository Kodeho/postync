/**
 * Classification des échecs de plateforme (C10.2b).
 *
 * POURQUOI. Un compte dont la plateforme refuse le jeton continuait
 * d'afficher « Connecté ». Constaté en conditions réelles le 2026-08-28 :
 * Facebook et Instagram rejetaient tous les appels, et l'interface affirmait
 * que tout allait bien. À 3 h du matin, une publication programmée échoue
 * alors sans que personne ne sache pourquoi — exactement la panne silencieuse
 * que le planificateur existe pour éliminer.
 *
 * LE PIÈGE À ÉVITER. Marquer un compte « révoqué » au moindre échec serait
 * pire que le défaut : une panne passagère, une limitation de débit ou un
 * blocage au niveau de l'APPLICATION forceraient des reconnexions inutiles —
 * et qui n'y changeraient rien. Le 2026-08-27, les deux apps Meta étaient
 * bloquées (« API access blocked. », OAuthException/200) alors que les
 * autorisations des comptes étaient parfaitement valides : les marquer
 * révoqués aurait envoyé le propriétaire reconnecter des comptes qui
 * n'avaient aucun problème.
 *
 * D'OÙ LA RÈGLE : on ne déclasse un compte que sur un signal NON AMBIGU
 * d'autorisation invalide. Dans le doute, on ne touche à rien. Un faux négatif
 * coûte un message d'erreur ; un faux positif coûte la confiance.
 */

export type FailureKind =
  /** L'autorisation de CE compte n'est plus valide : reconnexion nécessaire. */
  | "auth_revoked"
  /** Panne passagère, limitation de débit, réseau : rien à déclasser. */
  | "temporary"
  /** Refus métier (média non conforme, légende trop longue…) : compte sain. */
  | "other";

/**
 * Signaux d'autorisation invalide, par plateforme. Tous documentés et non
 * ambigus — c'est le critère d'entrée dans cette liste.
 */
const SIGNAUX_AUTH: RegExp[] = [
  // Meta (Facebook, Instagram) — OAuthException code 190 : jeton invalide,
  // expiré, ou autorisation retirée par l'utilisateur. Les sous-codes 458 à
  // 467 en relèvent tous. C'est LE code canonique de Meta pour « ce jeton
  // n'est plus valable » ; le code 200 (permissions) est délibérément absent,
  // parce qu'un blocage applicatif le produit aussi.
  /OAuthException\/190(\/|\b)/,
  // Google / YouTube — réponses standard du serveur d'autorisation.
  /\binvalid_grant\b/,
  /\binvalid_token\b/,
  // TikTok — refus explicite du jeton d'accès.
  /\baccess_token_invalid\b/,
];

/**
 * Signaux explicitement passagers. Testés AVANT les signaux d'authentification
 * pour qu'un 503 accompagné d'un texte trompeur ne déclasse pas un compte.
 */
const SIGNAUX_PASSAGERS: RegExp[] = [
  // Toute réponse 5xx : la plateforme est en peine, pas nous.
  /\bHTTP 5\d\d\b/,
  // Meta : limitations de débit et surcharges applicatives.
  /OAuthException\/(4|17|32|613)(\/|\b)/,
  // Trop de requêtes, quelle que soit la plateforme.
  /\bHTTP 429\b/,
  /\brate.?limit/i,
  /\btimeout\b/i,
];

/**
 * Classe un échec à partir du détail construit par le provider — jamais à
 * partir d'un corps de réponse brut, qui n'arrive pas jusqu'ici.
 */
export function classifyFailure(detail: string | null | undefined): FailureKind {
  if (!detail) return "other";

  if (SIGNAUX_PASSAGERS.some((motif) => motif.test(detail))) {
    return "temporary";
  }
  if (SIGNAUX_AUTH.some((motif) => motif.test(detail))) {
    return "auth_revoked";
  }
  return "other";
}

/** Le compte doit-il cesser d'apparaître « Connecté » ? */
export function requiresReconnect(detail: string | null | undefined): boolean {
  return classifyFailure(detail) === "auth_revoked";
}
