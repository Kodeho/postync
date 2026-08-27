import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MediaAsset } from "./rules";

/**
 * Lectures de la médiathèque, sous RLS : un membre ne voit que les médias de
 * SES workspaces. Comme pour `social_accounts`, la liste des colonnes est
 * explicite — une colonne ajoutée plus tard ne devient pas lisible par
 * accident.
 */
const MEDIA_COLUMNS =
  "id, workspace_id, storage_path, original_filename, mime_type, byte_size, kind, " +
  "width, height, duration_seconds, video_codec, status, status_detail, created_at";

export async function listMediaAssets(
  supabase: SupabaseClient,
  workspaceId: string,
  limit = 60,
): Promise<MediaAsset[]> {
  const { data, error } = await supabase
    .from("media_assets")
    .select(MEDIA_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`[media:list] ${error.code ?? "unknown"}: ${error.message}`);
    return [];
  }
  return (data ?? []) as unknown as MediaAsset[];
}

/** Médias publiables : seuls ceux dont le fichier a été déposé et mesuré. */
export async function listReadyMediaAssets(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<MediaAsset[]> {
  const { data, error } = await supabase
    .from("media_assets")
    .select(MEDIA_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(60);

  if (error) {
    console.error(`[media:list-ready] ${error.code ?? "unknown"}`);
    return [];
  }
  return (data ?? []) as unknown as MediaAsset[];
}
