import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { WorkspaceRole } from "@/types/workspace-role";

import type { InvitationRow, MemberRow } from "./invitations";

/**
 * Lectures de l'équipe (C14).
 *
 * Les membres passent par `workspace_members_detailed`, qui joint
 * `auth.users` — inaccessible autrement — et vérifie l'appartenance avec
 * `is_workspace_member`, l'aide déjà utilisée par toutes les politiques RLS
 * depuis C4.
 *
 * Les invitations passent par la table, sous RLS, avec la liste blanche de
 * colonnes : `token_hash` n'y figure pas, et n'est donc jamais lisible.
 */

type DetailedRow = {
  user_id: string;
  role: string;
  created_at: string;
  display_name: string | null;
  email: string | null;
};

const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member"];

function isRole(value: string): value is WorkspaceRole {
  return (ROLES as readonly string[]).includes(value);
}

export async function listWorkspaceMembers(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<MemberRow[]> {
  const { data, error } = await supabase.rpc("workspace_members_detailed", {
    p_workspace_id: workspaceId,
  });

  if (error) {
    console.error(`[team:members] ${error.code ?? "inconnu"}`);
    return [];
  }

  return ((data ?? []) as DetailedRow[])
    .filter((row) => isRole(row.role))
    .map((row) => ({
      user_id: row.user_id,
      role: row.role as WorkspaceRole,
      created_at: row.created_at,
      displayName: row.display_name,
      email: row.email,
    }));
}

/**
 * Invitations encore vivantes : ni acceptées, ni révoquées, ni expirées.
 *
 * Une invitation expirée n'est pas « en attente » — la présenter comme telle
 * ferait croire qu'elle finira par aboutir.
 */
export async function listPendingInvitations(
  supabase: SupabaseClient,
  workspaceId: string,
  now: number = Date.now(),
): Promise<InvitationRow[]> {
  const { data, error } = await supabase
    .from("workspace_invitations")
    // Liste explicite : `token_hash` n'est de toute façon pas accordé, mais
    // `*` échouerait sur cette table à liste blanche de colonnes.
    .select(
      "id, workspace_id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at",
    )
    .eq("workspace_id", workspaceId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date(now).toISOString())
    .order("created_at", { ascending: false });

  if (error) {
    console.error(`[team:invitations] ${error.code ?? "inconnu"}`);
    return [];
  }
  return (data ?? []) as unknown as InvitationRow[];
}

/** Sièges occupés : membres actuels plus invitations encore vivantes. */
export function seatsUsed(members: MemberRow[], pending: InvitationRow[]): number {
  return members.length + pending.length;
}
