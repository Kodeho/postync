import { connection } from "next/server";

import { AdminShell } from "@/components/admin/admin-shell";
import { requirePlatformRole } from "@/server/admin/authorization";

/**
 * Layout commun à `/admin/*`.
 *
 * `requirePlatformRole()` exige une session valide, un profil actif et un
 * platform_role de personnel (support, admin, super_admin). Tout autre
 * utilisateur obtient un 404 : l'administration n'est pas révélée. Les pages
 * refont leur propre contrôle (lecture mémoïsée) et les RPC en base
 * revérifient le rôle : l'interface n'est jamais la seule barrière.
 */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await connection();
  const actor = await requirePlatformRole();
  return <AdminShell actor={actor}>{children}</AdminShell>;
}
