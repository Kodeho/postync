import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type { WorkspaceRole } from "@/types/workspace-role";
import type { WorkspaceMembership } from "@/types/workspace";

/**
 * Lectures côté serveur liées aux workspaces.
 *
 * Ce module importe `@/lib/supabase/server` (donc `next/headers`) : il ne
 * peut pas fuiter vers le navigateur.
 *
 * Toutes les requêtes passent par le client anon + cookies de session : RLS
 * ne renvoie QUE les workspaces dont l'utilisateur courant est membre. Aucun
 * identifiant reçu du navigateur (slug d'URL compris) n'est considéré comme
 * une autorisation : c'est la base qui tranche.
 */

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/** Forme brute renvoyée par PostgREST pour la jointure imbriquée. */
type MembershipRow = {
  role: string;
  workspace: { id: string; name: string; slug: string } | null;
};

const WORKSPACE_ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member"];

function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/**
 * Session serveur faisant autorité : `getUser()` revalide le jeton auprès de
 * Supabase. Redirige vers `/login` sans session.
 */
export async function requireUser(): Promise<{
  supabase: SupabaseServerClient;
  user: User;
}> {
  if (!isSupabaseConfigured()) {
    redirect("/login");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return { supabase, user };
}

/**
 * Memberships de l'utilisateur courant, du plus ancien au plus récent.
 *
 * Le filtre `user_id` est redondant avec RLS (qui limite déjà aux workspaces
 * de l'utilisateur) mais explicite : un membre voit aussi les memberships
 * des AUTRES membres de ses workspaces, et l'on ne veut ici que les siennes.
 */
export async function listMemberships(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<WorkspaceMembership[]> {
  const { data, error } = await supabase
    .from("workspace_members")
    .select("role, workspace:workspaces(id, name, slug)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .overrideTypes<MembershipRow[], { merge: false }>();

  if (error) {
    console.error(`[workspaces:list] ${error.code ?? "unknown"}: ${error.message}`);
    return [];
  }

  const memberships: WorkspaceMembership[] = [];
  for (const row of data ?? []) {
    if (row.workspace && isWorkspaceRole(row.role)) {
      memberships.push({ role: row.role, workspace: row.workspace });
    }
  }
  return memberships;
}
