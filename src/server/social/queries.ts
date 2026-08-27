import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SocialAccountRow, SocialPublicationRow } from "./accounts";

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

/**
 * Publications récentes du workspace, sous RLS (un membre ne voit que les
 * siennes). Aucune colonne sensible n'existe dans cette table, mais la liste
 * blanche reste explicite comme pour `social_accounts`.
 */
const PUBLICATION_COLUMNS =
  "id, workspace_id, social_account_id, platform, provider_account_id, media_kind, " +
  "media_url, caption, container_id, provider_media_id, permalink, status, " +
  "status_detail, created_at, published_at";

export async function listRecentPublications(
  supabase: SupabaseClient,
  workspaceId: string,
  limit = 10,
): Promise<SocialPublicationRow[]> {
  const { data, error } = await supabase
    .from("social_publications")
    .select(PUBLICATION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`[social:publications] ${error.code ?? "unknown"}: ${error.message}`);
    return [];
  }
  return (data ?? []) as unknown as SocialPublicationRow[];
}

/** Nombre de publications comptées dans le quota du mois calendaire courant. */
export async function countPublicationsThisMonth(
  supabase: SupabaseClient,
  workspaceId: string,
  now: number = Date.now(),
): Promise<number> {
  const date = new Date(now);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();

  const { count, error } = await supabase
    .from("social_publications")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("status", ["published", "pending"])
    .gte("created_at", start)
    .lt("created_at", end);

  if (error) {
    console.error(`[social:publications:count] ${error.code ?? "unknown"}`);
    return 0;
  }
  return count ?? 0;
}
