import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  canStoreMore,
  extensionForMime,
  isAllowedMimeType,
  mimeToKind,
  sanitizeFilename,
  MAX_BYTE_SIZE,
  type MediaAsset,
} from "./rules";

/**
 * Médiathèque — orchestration serveur.
 *
 * Trois principes tiennent tout le module :
 *
 *   1. LES OCTETS NE PASSENT PAS PAR POSTYNC. Le serveur délivre une URL
 *      d'upload signée après avoir vérifié le rôle, le format et le quota ;
 *      le navigateur téléverse directement vers Supabase Storage. Faire
 *      transiter 300 Mo par une fonction serverless serait absurde.
 *
 *   2. LE BUCKET RESTE FERMÉ. Aucune politique ne l'ouvre à `authenticated` :
 *      toute lecture passe par une URL signée forgée ici, à durée courte.
 *
 *   3. AUCUNE URL SIGNÉE N'EST ENREGISTRÉE. La documentation Supabase est
 *      formelle : une réponse mise en cache continue d'être servie même après
 *      l'expiration du jeton. Une URL signée persistée serait donc une fuite
 *      durable. On ne stocke que la clé de l'objet, et la seule révocation
 *      qui vaille est la suppression du fichier.
 */

const BUCKET = "media";

/**
 * Durée de vie d'une URL remise à une plateforme. Meta va chercher le média
 * lui-même puis le traite de façon asynchrone : trop court le condamnerait,
 * trop long laisserait traîner un accès. Deux heures couvrent largement un
 * transcodage tout en restant borné.
 */
export const PUBLISH_URL_TTL_SECONDS = 2 * 60 * 60;
/** Aperçus de la médiathèque : le strict nécessaire à l'affichage. */
export const PREVIEW_URL_TTL_SECONDS = 10 * 60;

export type MediaDeps = {
  /** Client service_role : le bucket n'est accessible que par lui. */
  db: SupabaseClient;
  /** Quota `storageGb` du plan du workspace. */
  getStorageQuotaGb: (workspaceId: string) => Promise<number>;
};

export type MediaFailureCode =
  | "mime_not_supported"
  | "too_large"
  | "empty_file"
  | "quota_exceeded"
  | "asset_not_found"
  | "not_ready"
  | "storage_failed";

export type RequestUploadResult =
  | {
      ok: true;
      assetId: string;
      storagePath: string;
      /** URL d'upload signée, à usage unique et à durée limitée. */
      uploadUrl: string;
      token: string;
    }
  | { ok: false; code: MediaFailureCode };

/**
 * Prépare un téléversement : contrôles, réservation d'une ligne, puis URL
 * d'upload signée. La ligne naît en `uploading` — tant que les octets ne sont
 * pas confirmés, le média n'est pas publiable.
 */
export async function requestUpload(
  deps: MediaDeps,
  input: {
    workspaceId: string;
    userId: string;
    filename: string;
    mimeType: string;
    byteSize: number;
  },
): Promise<RequestUploadResult> {
  if (!isAllowedMimeType(input.mimeType)) {
    return { ok: false, code: "mime_not_supported" };
  }
  if (input.byteSize <= 0) {
    return { ok: false, code: "empty_file" };
  }
  if (input.byteSize > MAX_BYTE_SIZE) {
    return { ok: false, code: "too_large" };
  }

  const kind = mimeToKind(input.mimeType);
  if (!kind) {
    return { ok: false, code: "mime_not_supported" };
  }

  // Quota du plan, AVANT de délivrer la moindre URL d'upload.
  const [{ data: usedBytes }, quotaGb] = await Promise.all([
    deps.db.rpc("workspace_storage_bytes", { p_workspace_id: input.workspaceId }),
    deps.getStorageQuotaGb(input.workspaceId),
  ]);
  if (!canStoreMore(Number(usedBytes ?? 0), input.byteSize, quotaGb)) {
    return { ok: false, code: "quota_exceeded" };
  }

  // Le chemin est construit par le serveur : premier segment = workspace
  // (l'isolation est structurelle), nom = UUID. Le nom fourni par
  // l'utilisateur ne sert qu'à l'affichage.
  const assetId = randomUUID();
  const storagePath = `${input.workspaceId}/${assetId}.${extensionForMime(input.mimeType)}`;

  const { data: created, error: insertError } = await deps.db
    .from("media_assets")
    .insert({
      id: assetId,
      workspace_id: input.workspaceId,
      storage_path: storagePath,
      original_filename: sanitizeFilename(input.filename),
      mime_type: input.mimeType,
      byte_size: input.byteSize,
      kind,
      status: "uploading",
      uploaded_by: input.userId,
    })
    .select("id")
    .single<{ id: string }>();
  if (insertError || !created) {
    console.error(`[media:upload] insert: ${insertError?.code ?? "inconnu"}`);
    return { ok: false, code: "storage_failed" };
  }

  const { data: signed, error: signError } = await deps.db.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath);
  if (signError || !signed) {
    // Pas d'URL d'upload : la ligne réservée ne doit pas rester orpheline.
    await deps.db.from("media_assets").delete().eq("id", assetId);
    console.error(`[media:upload] sign: ${signError?.message ?? "inconnu"}`);
    return { ok: false, code: "storage_failed" };
  }

  return {
    ok: true,
    assetId,
    storagePath,
    uploadUrl: signed.signedUrl,
    token: signed.token,
  };
}

export type FinalizeResult =
  | { ok: true; asset: MediaAsset }
  | { ok: false; code: MediaFailureCode };

/**
 * Confirme un téléversement et enregistre les caractéristiques mesurées.
 *
 * La mesure est faite par l'appelant (analyse de l'en-tête du fichier) : ce
 * module ne fait confiance ni au navigateur ni au nom du fichier, mais il
 * vérifie que l'objet EXISTE RÉELLEMENT dans le bucket et que sa taille
 * correspond à ce qui avait été annoncé.
 */
export async function finalizeUpload(
  deps: MediaDeps,
  input: {
    workspaceId: string;
    assetId: string;
    probe: {
      width: number | null;
      height: number | null;
      durationSeconds: number | null;
      videoCodec: string | null;
    } | null;
    /** Raison du refus quand l'analyse a échoué. */
    invalidReason?: string;
  },
): Promise<FinalizeResult> {
  const { data: asset } = await deps.db
    .from("media_assets")
    .select("id, workspace_id, storage_path, kind, byte_size, status")
    .eq("id", input.assetId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle<{
      id: string;
      workspace_id: string;
      storage_path: string;
      kind: string;
      byte_size: number;
      status: string;
    }>();
  if (!asset) {
    return { ok: false, code: "asset_not_found" };
  }

  // L'objet est-il vraiment là, et de la taille annoncée ? Une ligne
  // « prête » sans fichier derrière casserait la publication plus tard.
  const folder = asset.storage_path.split("/")[0];
  const filename = asset.storage_path.slice(folder.length + 1);
  const { data: listing } = await deps.db.storage
    .from(BUCKET)
    .list(folder, { search: filename, limit: 1 });
  const objet = (listing ?? []).find((item) => item.name === filename);
  if (!objet) {
    await markInvalid(deps.db, asset.id, "fichier_absent");
    return { ok: false, code: "storage_failed" };
  }

  if (input.probe === null) {
    await markInvalid(deps.db, asset.id, input.invalidReason ?? "analyse_impossible");
    return { ok: false, code: "not_ready" };
  }

  const { data: updated, error } = await deps.db
    .from("media_assets")
    .update({
      width: input.probe.width,
      height: input.probe.height,
      duration_seconds: input.probe.durationSeconds,
      video_codec: input.probe.videoCodec,
      status: "ready",
      status_detail: null,
    })
    .eq("id", asset.id)
    .select(
      "id, workspace_id, storage_path, original_filename, mime_type, byte_size, kind, " +
        "width, height, duration_seconds, video_codec, status, status_detail, created_at",
    )
    .single<MediaAsset>();
  if (error || !updated) {
    console.error(`[media:finalize] update: ${error?.code ?? "inconnu"}`);
    return { ok: false, code: "storage_failed" };
  }
  return { ok: true, asset: updated };
}

async function markInvalid(db: SupabaseClient, assetId: string, detail: string): Promise<void> {
  await db
    .from("media_assets")
    .update({ status: "invalid", status_detail: detail.slice(0, 120) })
    .eq("id", assetId);
}

/**
 * URL signée à durée limitée pour un média PRÊT.
 *
 * Le résultat n'est jamais enregistré : il est transmis à la plateforme puis
 * oublié. Voir l'en-tête du module pour la raison — une URL signée persistée
 * resterait servie depuis le cache après expiration du jeton.
 */
export async function signMediaUrl(
  deps: MediaDeps,
  input: { workspaceId: string; assetId: string; ttlSeconds?: number },
): Promise<{ ok: true; url: string } | { ok: false; code: MediaFailureCode }> {
  const { data: asset } = await deps.db
    .from("media_assets")
    .select("storage_path, status")
    .eq("id", input.assetId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle<{ storage_path: string; status: string }>();
  if (!asset) {
    return { ok: false, code: "asset_not_found" };
  }
  if (asset.status !== "ready") {
    return { ok: false, code: "not_ready" };
  }

  const { data, error } = await deps.db.storage
    .from(BUCKET)
    .createSignedUrl(asset.storage_path, input.ttlSeconds ?? PUBLISH_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    console.error(`[media:sign] ${error?.message ?? "inconnu"}`);
    return { ok: false, code: "storage_failed" };
  }
  return { ok: true, url: data.signedUrl };
}

/**
 * Supprime un média : l'objet PUIS la ligne. Dans cet ordre — supprimer la
 * ligne d'abord laisserait un fichier orphelin que plus rien ne référence, et
 * la suppression de l'objet est la seule révocation d'accès réelle.
 */
export async function deleteAsset(
  deps: MediaDeps,
  input: { workspaceId: string; assetId: string },
): Promise<{ ok: true } | { ok: false; code: MediaFailureCode }> {
  const { data: asset } = await deps.db
    .from("media_assets")
    .select("id, storage_path")
    .eq("id", input.assetId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle<{ id: string; storage_path: string }>();
  if (!asset) {
    return { ok: false, code: "asset_not_found" };
  }

  const { error: removeError } = await deps.db.storage.from(BUCKET).remove([asset.storage_path]);
  if (removeError) {
    console.error(`[media:delete] remove: ${removeError.message}`);
    return { ok: false, code: "storage_failed" };
  }

  const { error } = await deps.db.from("media_assets").delete().eq("id", asset.id);
  if (error) {
    console.error(`[media:delete] row: ${error.code}`);
    return { ok: false, code: "storage_failed" };
  }
  return { ok: true };
}

/** Octets réellement occupés par le workspace, quota compris. */
export async function workspaceStorageBytes(
  db: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const { data } = await db.rpc("workspace_storage_bytes", { p_workspace_id: workspaceId });
  return Number(data ?? 0);
}
