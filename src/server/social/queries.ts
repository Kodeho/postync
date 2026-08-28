import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SocialAccountRow, SocialPublicationRow } from "./accounts";
import { QUOTA_STATUSES } from "./publish";

/**
 * Lectures sous RLS : un membre ne voit que les comptes de SES workspaces,
 * et uniquement les colonnes de la liste blanche (les références Vault sont
 * exclues des GRANT de colonnes — les sélectionner échouerait en 42501).
 */
const SAFE_COLUMNS =
  "id, workspace_id, platform, provider_account_id, display_name, avatar_url, " +
  "token_expires_at, refresh_expires_at, scopes, status, status_detail, connected_at, can_refresh";

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
  "status_detail, created_at, published_at, scheduled_at";

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

  // `select("id")` et NON `select("*")`. La table est protégée par une liste
  // blanche de colonnes : `*` exige un droit sur TOUTES les colonnes, donc la
  // moindre colonne d'exploitation non accordée (ici `attempts`, C10.1) fait
  // échouer la requête. `count` vaut alors null, et le compteur affiche 0 sans
  // rien signaler. `id` est toujours accordée.
  const { count, error } = await supabase
    .from("social_publications")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("status", QUOTA_STATUSES as unknown as string[])
    // Même règle que la publication et la planification : le mois où la
    // publication a LIEU. Un affichage qui divergerait du quota réellement
    // appliqué serait pire qu'absent.
    .gte("effective_at", start)
    .lt("effective_at", end);

  if (error) {
    console.error(`[social:publications:count] ${error.code ?? "unknown"}`);
    return 0;
  }
  return count ?? 0;
}
