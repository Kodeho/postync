import { isAuthError } from "@supabase/supabase-js";

/**
 * Traduction des erreurs Supabase en messages compréhensibles.
 *
 * Règle de sécurité : aucun message technique Supabase n'est renvoyé à
 * l'utilisateur. Les codes inconnus retombent sur un message générique, et
 * le détail réel est journalisé côté serveur uniquement.
 *
 * Les codes proviennent de `@supabase/auth-js` (`lib/error-codes.d.ts`).
 */
const MESSAGES: Record<string, string> = {
  invalid_credentials: "Adresse e-mail ou mot de passe incorrect.",
  email_not_confirmed:
    "Votre adresse e-mail n'est pas encore confirmée. Consultez votre boîte de réception.",
  email_exists: "Cette adresse e-mail est déjà utilisée.",
  user_already_exists: "Cette adresse e-mail est déjà utilisée.",
  email_address_invalid: "Cette adresse e-mail est invalide.",
  email_address_not_authorized: "Cette adresse e-mail n'est pas autorisée.",
  weak_password:
    "Ce mot de passe est trop faible. Choisissez-en un plus long et plus varié.",
  same_password: "Le nouveau mot de passe doit être différent de l'ancien.",
  user_banned: "Ce compte est suspendu. Contactez le support.",
  signup_disabled: "Les inscriptions sont temporairement désactivées.",
  email_provider_disabled:
    "L'inscription par e-mail est temporairement désactivée.",
  over_request_rate_limit:
    "Trop de tentatives. Patientez quelques minutes avant de réessayer.",
  over_email_send_rate_limit:
    "Trop d'e-mails envoyés. Patientez quelques minutes avant de réessayer.",
  validation_failed: "Les informations saisies sont invalides.",
  session_expired: "Votre session a expiré. Veuillez vous reconnecter.",
  captcha_failed: "La vérification anti-robot a échoué. Réessayez.",
  request_timeout: "Le service a mis trop de temps à répondre. Réessayez.",
};

const FALLBACK =
  "Une erreur est survenue. Veuillez réessayer dans quelques instants.";

/**
 * Convertit une erreur quelconque en message affichable.
 * Journalise l'erreur d'origine côté serveur pour le diagnostic.
 */
export function toUserMessage(error: unknown, context: string): string {
  if (isAuthError(error)) {
    const code = error.code ?? "";
    const known = MESSAGES[code];

    console.error(
      `[auth:${context}] ${error.name} code=${code || "none"} status=${error.status ?? "none"}`,
    );

    return known ?? FALLBACK;
  }

  if (error instanceof Error) {
    console.error(`[auth:${context}] ${error.name}: ${error.message}`);
  } else {
    console.error(`[auth:${context}] erreur non typée`);
  }

  return FALLBACK;
}
