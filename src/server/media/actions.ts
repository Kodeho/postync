"use server";

import { revalidatePath } from "next/cache";

import { listMemberships, requireUser } from "@/features/workspaces/queries";
import { findMembershipBySlug } from "@/features/workspaces/resolve";
import { getWorkspaceAccess } from "@/server/billing/queries";
import { createServiceClient } from "@/server/supabase/service-client";
import type { WorkspaceMembership } from "@/types/workspace";

import {
  deleteAsset,
  finalizeUpload,
  requestUpload,
  signMediaUrl,
  PREVIEW_URL_TTL_SECONDS,
  type MediaDeps,
  type MediaFailureCode,
} from "./library";

/**
 * Server Actions de la médiathèque.
 *
 * Même chaîne de sécurité que les comptes sociaux : session revalidée,
 * workspace résolu par slug contre les memberships réelles sous RLS, et seuls
 * owner et admin peuvent déposer ou supprimer. Le navigateur n'envoie qu'un
 * slug, un nom de fichier, un type et une taille — tout est revérifié.
 *
 * Les octets ne passent JAMAIS par ici : ces actions ne délivrent qu'une URL
 * d'upload signée, et le navigateur téléverse directement vers le stockage.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_ALLOWED =
  "Seul le propriétaire ou un admin du workspace peut gérer la médiathèque.";

const MEDIA_ERRORS: Record<MediaFailureCode, string> = {
  mime_not_supported:
    "Format non pris en charge. POSTYNC accepte les vidéos MP4 ou MOV et les images JPEG.",
  too_large: "Ce fichier dépasse la limite de 300 Mo.",
  empty_file: "Ce fichier est vide.",
  quota_exceeded:
    "L'espace de stockage de votre plan est atteint. Supprimez des médias ou passez à un plan supérieur.",
  asset_not_found: "Média introuvable.",
  not_ready: "Ce média n'est pas encore prêt.",
  invalid_media: "Ce fichier n'a pas pu être validé.",
  storage_failed: "Le stockage n'a pas répondu. Réessayez.",
};

async function requireMediaManager(
  formData: FormData,
): Promise<{ ok: true; membership: WorkspaceMembership } | { ok: false; error: string }> {
  const slug = String(formData.get("workspaceSlug") ?? "");
  const { supabase, user } = await requireUser();
  const memberships = await listMemberships(supabase, user.id);
  const membership = findMembershipBySlug(memberships, slug);
  if (!membership) {
    return { ok: false, error: "Workspace introuvable." };
  }
  if (membership.role !== "owner" && membership.role !== "admin") {
    return { ok: false, error: NOT_ALLOWED };
  }
  return { ok: true, membership };
}

async function mediaDeps(): Promise<MediaDeps> {
  const { supabase } = await requireUser();
  return {
    db: createServiceClient(),
    getStorageQuotaGb: async (workspaceId: string) => {
      const { access } = await getWorkspaceAccess(supabase, workspaceId);
      return access.quotas.storageGb;
    },
  };
}

export type UploadTicketState = {
  error: string | null;
  ticket: { assetId: string; uploadUrl: string } | null;
};

export const IDLE_UPLOAD_TICKET: UploadTicketState = { error: null, ticket: null };

/**
 * Délivre une URL d'upload signée après contrôle du rôle, du format et du
 * quota. Le média est réservé en base mais reste non publiable tant que les
 * octets ne sont pas confirmés.
 */
export async function requestUploadAction(
  _prev: UploadTicketState,
  formData: FormData,
): Promise<UploadTicketState> {
  const auth = await requireMediaManager(formData);
  if (!auth.ok) {
    return { error: auth.error, ticket: null };
  }

  const filename = String(formData.get("filename") ?? "");
  const mimeType = String(formData.get("mimeType") ?? "");
  const byteSize = Number(formData.get("byteSize") ?? 0);
  if (!filename || !Number.isFinite(byteSize)) {
    return { error: "Fichier invalide.", ticket: null };
  }

  const { user } = await requireUser();
  const result = await requestUpload(await mediaDeps(), {
    workspaceId: auth.membership.workspace.id,
    userId: user.id,
    filename,
    mimeType,
    byteSize: Math.floor(byteSize),
  });

  if (!result.ok) {
    return { error: MEDIA_ERRORS[result.code], ticket: null };
  }
  return {
    error: null,
    ticket: { assetId: result.assetId, uploadUrl: result.uploadUrl },
  };
}

export type MediaActionState = { error: string | null; notice: string | null };
export const IDLE_MEDIA_ACTION: MediaActionState = { error: null, notice: null };

/**
 * Confirme un téléversement : le serveur vérifie que le fichier existe
 * réellement puis le MESURE lui-même à partir de son en-tête.
 */
export async function finalizeUploadAction(
  _prev: MediaActionState,
  formData: FormData,
): Promise<MediaActionState> {
  const auth = await requireMediaManager(formData);
  if (!auth.ok) {
    return { error: auth.error, notice: null };
  }
  const assetId = String(formData.get("assetId") ?? "");
  if (!UUID.test(assetId)) {
    return { error: "Média invalide.", notice: null };
  }

  const result = await finalizeUpload(createServiceClient(), {
    workspaceId: auth.membership.workspace.id,
    assetId,
  });

  revalidatePath(`/app/${auth.membership.workspace.slug}/media`);

  if (!result.ok) {
    // Le message du module d'analyse est plus précis que le code générique.
    return { error: result.message ?? MEDIA_ERRORS[result.code], notice: null };
  }
  return { error: null, notice: `« ${result.asset.original_filename} » est prêt.` };
}

/** Supprime un média : l'objet du bucket PUIS la ligne. */
export async function deleteMediaAction(
  _prev: MediaActionState,
  formData: FormData,
): Promise<MediaActionState> {
  const auth = await requireMediaManager(formData);
  if (!auth.ok) {
    return { error: auth.error, notice: null };
  }
  const assetId = String(formData.get("assetId") ?? "");
  if (!UUID.test(assetId)) {
    return { error: "Média invalide.", notice: null };
  }

  const result = await deleteAsset(createServiceClient(), {
    workspaceId: auth.membership.workspace.id,
    assetId,
  });

  revalidatePath(`/app/${auth.membership.workspace.slug}/media`);

  if (!result.ok) {
    return { error: MEDIA_ERRORS[result.code], notice: null };
  }
  return { error: null, notice: "Média supprimé." };
}

/**
 * URL d'aperçu, forgée à la demande et à durée très courte. Elle sert à
 * afficher une vignette dans la médiathèque — elle n'est ni stockée ni
 * réutilisée d'une page à l'autre.
 */
export async function previewUrlAction(
  workspaceSlug: string,
  assetId: string,
): Promise<string | null> {
  const form = new FormData();
  form.set("workspaceSlug", workspaceSlug);
  const auth = await requireMediaManager(form);
  if (!auth.ok || !UUID.test(assetId)) {
    return null;
  }
  const result = await signMediaUrl(createServiceClient(), {
    workspaceId: auth.membership.workspace.id,
    assetId,
    ttlSeconds: PREVIEW_URL_TTL_SECONDS,
  });
  return result.ok ? result.url : null;
}
