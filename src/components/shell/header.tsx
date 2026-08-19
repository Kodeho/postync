import { Bell } from "lucide-react";

import type { WorkspaceContext } from "@/features/workspaces/context";
import { userLabel } from "@/features/workspaces/context";

import { HeaderTitle } from "./header-title";
import { MobileNav } from "./mobile-nav";
import { Sidebar } from "./sidebar";
import { UserMenu } from "./user-menu";

type HeaderProps = {
  ctx: WorkspaceContext;
};

/** En-tête léger : menu mobile, titre de page, notifications (placeholder), avatar. */
export function Header({ ctx }: HeaderProps) {
  const slug = ctx.active.workspace.slug;

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6">
      <MobileNav>
        <Sidebar ctx={ctx} />
      </MobileNav>

      <HeaderTitle slug={slug} workspaceName={ctx.active.workspace.name} />

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          disabled
          aria-label="Notifications (bientôt disponible)"
          title="Notifications (bientôt disponible)"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted disabled:cursor-default disabled:opacity-60"
        >
          <Bell aria-hidden="true" className="h-4 w-4" />
        </button>
        <UserMenu
          label={userLabel(ctx)}
          email={ctx.user.email}
          avatarUrl={ctx.profile.avatarUrl}
          seed={ctx.user.id}
          slug={slug}
          variant="compact"
          placement="bottom"
        />
      </div>
    </header>
  );
}
