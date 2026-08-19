import type { ReactNode } from "react";

import type { WorkspaceContext } from "@/features/workspaces/context";

import { Header } from "./header";
import { Sidebar } from "./sidebar";

type AppShellProps = {
  ctx: WorkspaceContext;
  children: ReactNode;
};

/**
 * Shell principal : sidebar fixe sur desktop (lg+), header collant, contenu.
 * Server Component : seuls le switcher, les menus et le tiroir mobile sont
 * des composants client.
 */
export function AppShell({ ctx, children }: AppShellProps) {
  return (
    <div className="flex min-h-dvh w-full">
      <aside
        aria-label="Barre latérale"
        className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-surface lg:block"
      >
        <Sidebar ctx={ctx} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <Header ctx={ctx} />
        <main
          id="content"
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
