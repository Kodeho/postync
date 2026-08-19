/** Navigation de l'administration Kodeho — logique pure. */

export type AdminNavKey =
  | "dashboard"
  | "users"
  | "workspaces"
  | "subscriptions"
  | "plans"
  | "platform"
  | "audit";

export type AdminNavItem = {
  key: AdminNavKey;
  label: string;
  href: string;
  /** Réservé admin/super_admin (le support ne le voit pas). */
  adminOnly?: boolean;
};

export const ADMIN_NAV: readonly AdminNavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/admin" },
  { key: "users", label: "Utilisateurs", href: "/admin/users" },
  { key: "workspaces", label: "Workspaces", href: "/admin/workspaces" },
  { key: "subscriptions", label: "Abonnements", href: "/admin/subscriptions" },
  { key: "plans", label: "Plans", href: "/admin/plans" },
  { key: "platform", label: "Plateforme", href: "/admin/platform" },
  { key: "audit", label: "Audit", href: "/admin/audit", adminOnly: true },
];

export function isAdminNavActive(pathname: string, item: AdminNavItem): boolean {
  const current = pathname.replace(/\/+$/, "") || "/";
  if (item.href === "/admin") {
    return current === "/admin";
  }
  return current === item.href || current.startsWith(`${item.href}/`);
}

export function findActiveAdminNavItem(pathname: string): AdminNavItem | null {
  const sorted = [...ADMIN_NAV].sort((a, b) => b.href.length - a.href.length);
  return sorted.find((item) => isAdminNavActive(pathname, item)) ?? null;
}

/** Éléments visibles pour un rôle (le support ne voit pas l'audit). */
export function adminNavFor(canReadAudit: boolean): AdminNavItem[] {
  return ADMIN_NAV.filter((item) => !item.adminOnly || canReadAudit);
}
