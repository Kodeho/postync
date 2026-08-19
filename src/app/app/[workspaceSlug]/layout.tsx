import { connection } from "next/server";

import { AppShell } from "@/components/shell/app-shell";
import { getWorkspaceContext } from "@/features/workspaces/context";

/**
 * Layout commun à `/app/[workspaceSlug]/*`.
 *
 * Résout le contexte du workspace actif (session, memberships, profil) sous
 * RLS et rend le shell (sidebar, header). Un slug non résolu produit un 404
 * dès ici. Les pages rappellent `getWorkspaceContext()` : l'appel est
 * mémoïsé par requête, et chaque page reste ainsi sa propre barrière.
 */
export default async function WorkspaceLayout({
  params,
  children,
}: LayoutProps<"/app/[workspaceSlug]">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);

  return <AppShell ctx={ctx}>{children}</AppShell>;
}
