import Link from "next/link";

import { PRODUCT_NAME } from "@/config/product";
import type { WorkspaceContext } from "@/features/workspaces/context";
import { userLabel } from "@/features/workspaces/context";
import { workspaceHref } from "@/features/workspaces/navigation";

import { SidebarNav } from "./sidebar-nav";
import { UserMenu } from "./user-menu";
import { WorkspaceSwitcher } from "./workspace-switcher";

type SidebarProps = {
  ctx: WorkspaceContext;
};

/**
 * Contenu de la barre latérale (Server Component). Utilisé tel quel sur
 * desktop et à l'intérieur du tiroir mobile.
 */
export function Sidebar({ ctx }: SidebarProps) {
  const slug = ctx.active.workspace.slug;

  return (
    <div className="flex h-full flex-col gap-5 p-4">
      <Link
        href={workspaceHref(slug)}
        className="flex h-9 items-center px-1 text-base font-semibold tracking-tight text-foreground"
      >
        {PRODUCT_NAME}
      </Link>

      <WorkspaceSwitcher active={ctx.active} memberships={ctx.memberships} />

      <div className="flex flex-1 flex-col gap-5">
        <SidebarNav slug={slug} section="main" ariaLabel="Navigation principale" />
        <div className="border-t border-border" />
        <SidebarNav slug={slug} section="secondary" ariaLabel="Navigation secondaire" />
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <SidebarNav slug={slug} section="footer" ariaLabel="Abonnement" />
        <UserMenu
          label={userLabel(ctx)}
          email={ctx.user.email}
          avatarUrl={ctx.profile.avatarUrl}
          seed={ctx.user.id}
          slug={slug}
          variant="full"
          placement="top"
        />
      </div>
    </div>
  );
}
