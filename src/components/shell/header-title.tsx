"use client";

import { usePathname } from "next/navigation";

import { findActiveNavItem } from "@/features/workspaces/navigation";

/** Titre de la page courante dans le header, déduit de la route active. */
export function HeaderTitle({
  slug,
  workspaceName,
}: {
  slug: string;
  workspaceName: string;
}) {
  const pathname = usePathname();
  const item = findActiveNavItem(pathname, slug);
  const title = item?.label ?? workspaceName;

  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-muted">{workspaceName}</p>
      <p className="truncate text-sm font-semibold text-foreground">{title}</p>
    </div>
  );
}
