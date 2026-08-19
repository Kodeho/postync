import { ArrowLeft, LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { MobileNav } from "@/components/shell/mobile-nav";
import { Avatar } from "@/components/ui/avatar";
import { PRODUCT_NAME } from "@/config/product";
import { signOutAction } from "@/features/auth/actions";
import type { AdminActor } from "@/server/admin/authorization";
import { can } from "@/server/admin/permissions";

import { AdminHeaderTitle } from "./admin-header-title";
import { AdminSidebarNav } from "./admin-sidebar-nav";

type AdminShellProps = {
  actor: AdminActor;
  children: ReactNode;
};

/**
 * Shell de l'administration Kodeho : même famille visuelle que POSTYNC,
 * mais clairement identifié « POSTYNC ADMIN by Kodeho » et sans aucun
 * élément de workspace. Server Component ; la navigation active et le tiroir
 * mobile sont les seuls composants client.
 */
export function AdminShell({ actor, children }: AdminShellProps) {
  const sidebar = <AdminSidebar actor={actor} />;

  return (
    <div className="flex min-h-dvh w-full">
      <aside
        aria-label="Barre latérale administration"
        className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-surface lg:block"
      >
        {sidebar}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6">
          <MobileNav>{sidebar}</MobileNav>
          <AdminHeaderTitle />
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-muted px-2.5 py-1 text-xs font-medium text-muted">
            <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
            {actor.role}
          </span>
        </header>
        <main id="content" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function AdminSidebar({ actor }: { actor: AdminActor }) {
  const label = actor.displayName ?? actor.user.email ?? "Administrateur";

  return (
    <div className="flex h-full flex-col gap-5 p-4">
      <Link href="/admin" className="flex flex-col px-1 leading-tight">
        <span className="text-base font-semibold tracking-tight text-foreground">
          {PRODUCT_NAME}{" "}
          <span className="rounded-sm bg-foreground px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-surface">
            Admin
          </span>
        </span>
        <span className="text-xs text-muted">by Kodeho</span>
      </Link>

      <div className="flex-1">
        <AdminSidebarNav canReadAudit={can(actor.role, "audit.read")} />
      </div>

      <div className="flex flex-col gap-1 border-t border-border pt-4">
        <Link
          href="/app"
          className="flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          Retour à POSTYNC
        </Link>
        <div className="flex items-center gap-3 px-2 py-2">
          <Avatar label={label} seed={actor.user.id} size="md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{label}</span>
            <span className="block truncate text-xs text-muted">
              {actor.user.email} · {actor.role}
            </span>
          </span>
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            className="flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-muted hover:bg-surface-muted hover:text-foreground"
          >
            <LogOut aria-hidden="true" className="h-4 w-4" />
            Déconnexion
          </button>
        </form>
      </div>
    </div>
  );
}
