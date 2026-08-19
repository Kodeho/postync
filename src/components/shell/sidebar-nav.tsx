"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  isNavItemActive,
  navItemsFor,
  workspaceHref,
  type NavItem,
  type NavSection,
} from "@/features/workspaces/navigation";

import { NavIcon } from "./nav-icon";

type SidebarNavProps = {
  slug: string;
  section: NavSection;
  ariaLabel: string;
};

/**
 * Liste de liens d'une section de navigation. Composant client uniquement
 * pour connaître la route active (`usePathname`).
 */
export function SidebarNav({ slug, section, ariaLabel }: SidebarNavProps) {
  const pathname = usePathname();
  const items = navItemsFor(section);

  return (
    <nav aria-label={ariaLabel}>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.key}>
            <NavLink
              item={item}
              href={workspaceHref(slug, item.segment)}
              active={isNavItemActive(pathname, slug, item)}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function NavLink({
  item,
  href,
  active,
}: {
  item: NavItem;
  href: string;
  active: boolean;
}) {
  const tone = active
    ? "bg-primary-soft text-primary"
    : "text-muted hover:bg-surface-muted hover:text-foreground";

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors ${tone}`}
    >
      <NavIcon name={item.key} className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}
