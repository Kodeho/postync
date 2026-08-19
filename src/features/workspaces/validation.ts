import type { Validated } from "@/features/auth/validation";

/** Aligné sur la contrainte `workspaces_name_length` (1 à 80 caractères). */
export const WORKSPACE_NAME_MAX_LENGTH = 80;

/** Aligné sur la contrainte `workspaces_slug_format` (60 caractères max). */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 60;

export function validateWorkspaceName(form: FormData): Validated<string> {
  const name = String(form.get("name") ?? "").trim();

  if (name.length === 0) {
    return { ok: false, error: "Le nom du workspace est obligatoire." };
  }

  if (name.length > WORKSPACE_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Le nom ne doit pas dépasser ${WORKSPACE_NAME_MAX_LENGTH} caractères.`,
    };
  }

  return { ok: true, value: name };
}

/**
 * Un segment d'URL n'est accepté comme slug que s'il respecte exactement le
 * format imposé par la base. Tout le reste est traité comme inexistant, sans
 * même interroger Supabase.
 */
export function isValidWorkspaceSlug(value: string): boolean {
  return value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}
