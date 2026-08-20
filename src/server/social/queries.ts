import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SocialAccountRow } from "./accounts";

/**
 * Lectures sous RLS : un membre ne voit que les comptes de SES workspaces,
 * et uniquement les colonnes de la liste blanche (les références Vault sont
 * exclues des GRANT de colonnes — les sélectionner échouerait en 42501).
 */
const SAFE_COLUMNS =
  "id, workspace_id, platform, provider_account_id, display_name, avatar_url, " +
  "token_expires_at, refresh_expires_at, scopes, status, status_detail, connected_at";

export async function listSocialAccounts(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<SocialAccountRow[]> {
  const { data, error } = await supabase
    .from("social_accounts")
    .select(SAFE_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("connected_at", { ascending: true });

  if (error) {
    console.error(`[social:list] ${error.code ?? "unknown"}: ${error.message}`);
    return [];
  }
  return (data ?? []) as unknown as SocialAccountRow[];
}
