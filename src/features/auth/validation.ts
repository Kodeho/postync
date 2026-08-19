import type { SignupPreservedValues } from "./state";

/** Longueur minimale imposée par Supabase Auth par défaut. */
export const PASSWORD_MIN_LENGTH = 8;

/** Longueur maximale acceptée pour le nom affiché. */
export const DISPLAY_NAME_MAX_LENGTH = 80;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type SignupInput = {
  displayName: string;
  email: string;
  password: string;
};

export type LoginInput = {
  email: string;
  password: string;
};

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Extrait les champs NON sensibles du formulaire d'inscription, tels qu'ils
 * peuvent être renvoyés au navigateur après une erreur.
 *
 * Ne lit volontairement ni `password` ni `confirmPassword`.
 */
export function extractSignupPreservedValues(
  form: FormData,
): SignupPreservedValues {
  return {
    displayName: String(form.get("displayName") ?? "").trim(),
    email: normalizeEmail(String(form.get("email") ?? "")),
  };
}

export function validateSignup(form: FormData): Validated<SignupInput> {
  const { displayName, email } = extractSignupPreservedValues(form);
  const password = String(form.get("password") ?? "");
  const confirmPassword = String(form.get("confirmPassword") ?? "");

  if (displayName.length === 0) {
    return { ok: false, error: "Le nom est obligatoire." };
  }

  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Le nom ne doit pas dépasser ${DISPLAY_NAME_MAX_LENGTH} caractères.`,
    };
  }

  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, error: "Veuillez saisir une adresse e-mail valide." };
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      error: `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères.`,
    };
  }

  if (password !== confirmPassword) {
    return { ok: false, error: "Les deux mots de passe ne sont pas identiques." };
  }

  return { ok: true, value: { displayName, email, password } };
}

export function validateLogin(form: FormData): Validated<LoginInput> {
  const email = normalizeEmail(String(form.get("email") ?? ""));
  const password = String(form.get("password") ?? "");

  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, error: "Veuillez saisir une adresse e-mail valide." };
  }

  if (password.length === 0) {
    return { ok: false, error: "Veuillez saisir votre mot de passe." };
  }

  return { ok: true, value: { email, password } };
}
