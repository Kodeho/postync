import type { PlatformRole } from "@/types/platform-role";

/**
 * Matrice de permissions de l'administration Kodeho — logique PURE.
 *
 * Cette matrice est la copie applicative de celle imposée en base par les
 * RPC `admin_*` (migration C6). La base fait autorité ; ici, elle sert à ne
 * pas proposer d'action impossible et à refuser tôt, avec un message clair.
 *
 * |                                 | support | admin | super_admin |
 * | Lire utilisateurs / workspaces  |   oui   |  oui  |     oui     |
 * | Suspendre / réactiver           |   non   |  oui  |     oui     |
 * | Full Access                     |   non   |  oui  |     oui     |
 * | Voir l'audit                    |   non   |  oui  |     oui     |
 * | Rôles user / support / admin    |   non   |  oui  |     oui     |
 * | Attribuer / modifier super_admin|   non   |  non  |     oui     |
 */

export const PLATFORM_STAFF_ROLES: readonly PlatformRole[] = [
  "support",
  "admin",
  "super_admin",
];

export const PLATFORM_ADMIN_ROLES: readonly PlatformRole[] = ["admin", "super_admin"];

export type AdminAction =
  | "users.read"
  | "workspaces.read"
  | "users.suspend"
  | "users.reactivate"
  | "users.change_role"
  | "workspaces.full_access"
  | "audit.read";

const MATRIX: Record<AdminAction, readonly PlatformRole[]> = {
  "users.read": PLATFORM_STAFF_ROLES,
  "workspaces.read": PLATFORM_STAFF_ROLES,
  "users.suspend": PLATFORM_ADMIN_ROLES,
  "users.reactivate": PLATFORM_ADMIN_ROLES,
  "users.change_role": PLATFORM_ADMIN_ROLES,
  "workspaces.full_access": PLATFORM_ADMIN_ROLES,
  "audit.read": PLATFORM_ADMIN_ROLES,
};

export function isPlatformRole(value: string | null | undefined): value is PlatformRole {
  return value === "user" || value === "support" || value === "admin" || value === "super_admin";
}

export function isPlatformStaff(role: PlatformRole | null | undefined): boolean {
  return role !== null && role !== undefined && PLATFORM_STAFF_ROLES.includes(role);
}

/** L'acteur peut-il effectuer cette action, en général (hors cible) ? */
export function can(role: PlatformRole | null | undefined, action: AdminAction): boolean {
  if (!role) return false;
  return MATRIX[action].includes(role);
}

export type Denial = { allowed: false; reason: string };
export type Decision = { allowed: true } | Denial;

function deny(reason: string): Denial {
  return { allowed: false, reason };
}

/** Peut-on changer le statut (suspendre / réactiver) de la cible ? */
export function decideStatusChange(input: {
  actorRole: PlatformRole;
  targetRole: PlatformRole;
  isSelf: boolean;
}): Decision {
  if (!can(input.actorRole, "users.suspend")) {
    return deny("Votre rôle ne permet pas de modifier le statut d'un compte.");
  }
  if (input.isSelf) {
    return deny("Impossible de modifier son propre statut.");
  }
  if (input.targetRole === "super_admin" && input.actorRole !== "super_admin") {
    return deny("Seul un super_admin peut modifier un super_admin.");
  }
  return { allowed: true };
}

/** Peut-on attribuer `newRole` à la cible ? (hors protection du dernier super_admin, vérifiée en base) */
export function decideRoleChange(input: {
  actorRole: PlatformRole;
  targetRole: PlatformRole;
  newRole: PlatformRole;
  isSelf: boolean;
}): Decision {
  if (!can(input.actorRole, "users.change_role")) {
    return deny("Votre rôle ne permet pas de modifier les rôles.");
  }
  // Son propre rôle : interdit, sauf démission d'un super_admin (la base
  // refuse encore si c'est le dernier super_admin actif).
  const selfResignation =
    input.isSelf && input.actorRole === "super_admin" && input.newRole !== "super_admin";
  if (input.isSelf && !selfResignation) {
    return deny("Impossible de modifier son propre rôle.");
  }
  if (input.actorRole !== "super_admin") {
    if (input.newRole === "super_admin") {
      return deny("Seul un super_admin peut attribuer le rôle super_admin.");
    }
    if (input.targetRole === "super_admin") {
      return deny("Seul un super_admin peut modifier un super_admin.");
    }
  }
  return { allowed: true };
}

/** Rôles qu'un acteur peut proposer pour une cible donnée (liste du formulaire). */
export function assignableRoles(input: {
  actorRole: PlatformRole;
  targetRole: PlatformRole;
  isSelf: boolean;
}): PlatformRole[] {
  const all: PlatformRole[] = ["user", "support", "admin", "super_admin"];
  return all.filter(
    (newRole) =>
      newRole !== input.targetRole &&
      decideRoleChange({ ...input, newRole }).allowed,
  );
}
