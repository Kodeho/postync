"use client";

import { usePathname } from "next/navigation";

import { findActiveAdminNavItem } from "./admin-navigation";

export function AdminHeaderTitle() {
  const pathname = usePathname();
  const item = findActiveAdminNavItem(pathname);

  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-muted">POSTYNC Admin</p>
      <p className="truncate text-sm font-semibold text-foreground">
        {item?.label ?? "Administration"}
      </p>
    </div>
  );
}
