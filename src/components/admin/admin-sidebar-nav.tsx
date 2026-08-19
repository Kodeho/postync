"use client";

import {
  BarChart3,
  Building2,
  CreditCard,
  LayoutDashboard,
  ScrollText,
  Server,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  adminNavFor,
  isAdminNavActive,
  type AdminNavKey,
} from "./admin-navigation";

const ICONS: Record<AdminNavKey, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  users: Users,
  workspaces: Building2,
  subscriptions: CreditCard,
  plans: BarChart3,
  platform: Server,
  audit: ScrollText,
};

export function AdminSidebarNav({ canReadAudit }: { canReadAudit: boolean }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Navigation administration">
      <ul className="flex flex-col gap-0.5">
        {adminNavFor(canReadAudit).map((item) => {
          const active = isAdminNavActive(pathname, item);
          const Icon = ICONS[item.key];
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors ${
                  active
                    ? "bg-foreground text-surface"
                    : "text-muted hover:bg-surface-muted hover:text-foreground"
                }`}
              >
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
