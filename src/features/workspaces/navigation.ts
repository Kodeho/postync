/**
 * Navigation du shell applicatif — logique pure, sans React ni Next.
 *
 * Toutes les routes privées sont relatives au workspace actif :
 * `/app/[workspaceSlug]/<segment>`. Le slug est toujours celui d'une
 * membership réelle (résolue côté serveur), jamais une valeur libre.
 */

export type NavSection = "main" | "secondary" | "footer";

export type NavItem = {
  /** Identifiant stable (sert de clé React et d'icône). */
  key: NavKey;
  label: string;
  /** Segment après le slug ; `""` = vue d'ensemble. */
  segment: string;
  section: NavSection;
};

export type NavKey =
  | "overview"
  | "publish"
  | "calendar"
  | "media"
  | "accounts"
  | "analytics"
  | "settings"
  | "billing";

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "overview", label: "Vue d'ensemble", segment: "", section: "main" },
  { key: "publish", label: "Publier", segment: "publish", section: "main" },
  { key: "calendar", label: "Calendrier", segment: "calendar", section: "main" },
  { key: "media", label: "Médiathèque", segment: "media", section: "main" },
  { key: "accounts", label: "Comptes sociaux", segment: "accounts", section: "main" },
  { key: "analytics", label: "Statistiques", segment: "analytics", section: "main" },
  { key: "settings", label: "Paramètres", segment: "settings", section: "secondary" },
  { key: "billing", label: "Abonnement", segment: "billing", section: "footer" },
];

export function navItemsFor(section: NavSection): NavItem[] {
  return NAV_ITEMS.filter((item) => item.section === section);
}

/** `/app/<slug>` ou `/app/<slug>/<segment>`. */
export function workspaceHref(slug: string, segment = ""): string {
  const base = `/app/${slug}`;
  return segment ? `${base}/${segment}` : base;
}

/**
 * Un élément est actif si le chemin courant est exactement sa route, ou un
 * sous-chemin de celle-ci. La vue d'ensemble (`/app/<slug>`) n'est active que
 * sur correspondance exacte, sinon elle le serait partout.
 */
export function isNavItemActive(
  pathname: string,
  slug: string,
  item: NavItem,
): boolean {
  const href = workspaceHref(slug, item.segment);
  const current = pathname.replace(/\/+$/, "") || "/";
  if (item.segment === "") {
    return current === href;
  }
  return current === href || current.startsWith(`${href}/`);
}

/** Élément de navigation correspondant au chemin courant (titre du header). */
export function findActiveNavItem(pathname: string, slug: string): NavItem | null {
  // Les segments les plus longs d'abord pour que `/settings/x` ne matche pas
  // la vue d'ensemble par erreur.
  const sorted = [...NAV_ITEMS].sort((a, b) => b.segment.length - a.segment.length);
  return sorted.find((item) => isNavItemActive(pathname, slug, item)) ?? null;
}
