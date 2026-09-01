import { redirect } from "next/navigation";
import { connection } from "next/server";

import { listMemberships, requireUser } from "@/features/workspaces/queries";
import { resolveAppRedirect } from "@/features/workspaces/resolve";
import { requireLegalAcceptance } from "@/server/legal/guard";

/**
 * `/app` — résolveur du workspace actif.
 *
 * Aucune préférence persistée en C4 : le workspace actif est porté par l'URL
 * (`/app/[workspaceSlug]`). Cette page se contente de diriger l'utilisateur :
 *
 *   aucun workspace   -> /onboarding
 *   un ou plusieurs   -> /app/<slug du plus ancien>
 *
 * La liste provient de `workspace_members` sous RLS : seuls les workspaces
 * dont l'utilisateur est réellement membre peuvent être proposés.
 */
export default async function AppIndexPage() {
  await connection();

  const { supabase, user } = await requireUser();

  // Point d'entrée de l'application : la garde s'applique ici aussi, sans
  // quoi `/app` renverrait vers `/onboarding` ou un workspace sans jamais
  // avoir demandé l'acceptation.
  await requireLegalAcceptance(supabase, user.id);

  const memberships = await listMemberships(supabase, user.id);

  redirect(resolveAppRedirect(memberships));
}
