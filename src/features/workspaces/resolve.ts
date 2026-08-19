import type { WorkspaceMembership } from "@/types/workspace";

import { isValidWorkspaceSlug } from "./validation";

/**
 * Résolution du workspace actif — logique pure, sans accès réseau.
 *
 * Les memberships passées ici proviennent TOUJOURS d'une lecture serveur sous
 * RLS (`listMemberships`). Le slug d'URL n'est qu'un sélecteur parmi elles :
 * il ne peut rien désigner que l'utilisateur ne possède déjà le droit de voir.
 */

/**
 * Retourne la membership correspondant au slug, ou `null` si le slug est mal
 * formé, inconnu, ou si l'utilisateur n'est pas membre — trois cas rendus
 * volontairement indiscernables.
 */
export function findMembershipBySlug(
  memberships: WorkspaceMembership[],
  slug: string,
): WorkspaceMembership | null {
  if (!isValidWorkspaceSlug(slug)) {
    return null;
  }
  return memberships.find((m) => m.workspace.slug === slug) ?? null;
}

/**
 * Destination de `/app` :
 *   aucun workspace  -> /onboarding
 *   sinon            -> /app/<slug de la première membership (la plus ancienne)>
 */
export function resolveAppRedirect(memberships: WorkspaceMembership[]): string {
  if (memberships.length === 0) {
    return "/onboarding";
  }
  return `/app/${memberships[0].workspace.slug}`;
}
