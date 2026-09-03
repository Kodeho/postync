import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { checkMediaForPlatform, type MediaKind } from "@/server/media/rules";
import {
  QUOTA_STATUSES,
  currentMonthRange,
  isPublishableMediaUrl,
  type PublishDeps,
  type PublishFailureCode,
} from "./publish";
import type { PublishMediaKind } from "./providers/types";
import { parseYouTubeMetadata, type YouTubeMetadata } from "@/lib/youtube-metadata";

/**
 * Planification d'une publication (C10.1).
 *
 * Une publication programmée est validée MAINTENANT et publiée PLUS TARD.
 * Ce décalage impose deux principes, qui expliquent la forme de ce module.
 *
 * 1. TOUT CE QUI PEUT ÊTRE VÉRIFIÉ À LA SAISIE L'EST À LA SAISIE. Découvrir
 *    à 3 h du matin qu'un média est au mauvais format, que le compte a été
 *    déconnecté ou que le quota est atteint, c'est un échec silencieux que
 *    personne ne verra passer. Les mêmes contrôles que la publication
 *    immédiate sont donc appliqués ici : appartenance du compte au workspace,
 *    compte actif, réseau capable de publier ce média, scopes réellement
 *    accordés, compatibilité du média, quota du plan.
 *
 * 2. CE QUI NE PEUT PAS ÊTRE GARANTI N'EST PAS PROMIS. Un compte peut être
 *    révoqué, un média supprimé, un jeton expiré entre la saisie et
 *    l'échéance. La validation d'aujourd'hui ne vaut pas garantie de demain :
 *    l'exécution revérifiera tout, et signalera l'échec plutôt que de le
 *    masquer.
 *
 * Aucune URL signée n'est forgée ici : elle le sera au moment de publier, et
 * n'aurait de toute façon aucun sens des heures à l'avance.
 */

/** Marge minimale : programmer « dans dix secondes » n'a pas de sens. */
export const MIN_LEAD_TIME_MS = 5 * 60_000;
/** Horizon maximal : au-delà, le jeton et le média n'ont plus de sens. */
export const MAX_HORIZON_MS = 365 * 24 * 3600 * 1000;

const CAPTION_MAX_LENGTH = 2200;

export type ScheduleFailureCode =
  | PublishFailureCode
  | "schedule_too_soon"
  | "schedule_too_far"
  | "schedule_invalid";

export type ScheduleOutcome =
  | { ok: true; publicationId: string; scheduledAt: string }
  | { ok: false; code: ScheduleFailureCode };

export type ScheduleRequest = {
  workspaceId: string;
  socialAccountId: string;
  requestedBy: string;
  mediaKind: PublishMediaKind;
  mediaAssetId?: string | null;
  mediaUrl?: string;
  caption: string | null;
  /**
   * Métadonnées YouTube. Elles sont validées ET ENREGISTRÉES ici : c'est la
   * saisie qui fait foi, pas l'exécution. Le planificateur les relira dans la
   * ligne, il ne les redemandera à personne.
   */
  title?: string | null;
  privacyStatus?: string | null;
  madeForKids?: boolean | null;
  guidelinesAcknowledged?: boolean | null;
  /** Échéance demandée, en ISO 8601. */
  scheduledAt: string;
};

type AccountRow = {
  id: string;
  workspace_id: string;
  platform: string;
  provider_account_id: string;
  scopes: string[] | null;
  status: string;
};

type AssetRow = {
  id: string;
  kind: MediaKind;
  status: string;
  storage_path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  video_codec: string | null;
};

/**
 * Valide une échéance. Renvoie la date normalisée, ou le motif du refus.
 *
 * La marge basse n'est pas un caprice : entre la saisie et le premier réveil
 * du planificateur il s'écoule jusqu'à une minute, et publier « dans trente
 * secondes » donnerait un résultat qui semblerait aléatoire à l'utilisateur.
 * Mieux vaut refuser clairement et proposer la publication immédiate.
 */
export function validateScheduledAt(
  value: string,
  now: number,
): { ok: true; iso: string } | { ok: false; code: ScheduleFailureCode } {
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return { ok: false, code: "schedule_invalid" };
  }
  if (time - now < MIN_LEAD_TIME_MS) {
    return { ok: false, code: "schedule_too_soon" };
  }
  if (time - now > MAX_HORIZON_MS) {
    return { ok: false, code: "schedule_too_far" };
  }
  return { ok: true, iso: date.toISOString() };
}

/**
 * Programme une publication. La ligne créée porte le statut `scheduled` ;
 * c'est le planificateur qui la réclamera à l'échéance.
 */
export async function schedulePublication(
  deps: PublishDeps,
  request: ScheduleRequest,
): Promise<ScheduleOutcome> {
  const { db } = deps;
  const now = deps.now ?? Date.now;

  const echeance = validateScheduledAt(request.scheduledAt, now());
  if (!echeance.ok) {
    return echeance;
  }

  if (request.caption && request.caption.length > CAPTION_MAX_LENGTH) {
    return { ok: false, code: "caption_too_long" };
  }
  if (!request.mediaAssetId && !isPublishableMediaUrl(request.mediaUrl ?? "")) {
    return { ok: false, code: "invalid_media_url" };
  }

  // Le compte doit appartenir au workspace : filtre sur les DEUX colonnes.
  const { data: account } = await db
    .from("social_accounts")
    .select("id, workspace_id, platform, provider_account_id, scopes, status")
    .eq("id", request.socialAccountId)
    .eq("workspace_id", request.workspaceId)
    .maybeSingle<AccountRow>();
  if (!account) {
    return { ok: false, code: "account_not_found" };
  }
  if (account.status !== "active") {
    return { ok: false, code: "account_inactive" };
  }

  const provider = deps.getProvider(account.platform);
  const publisher = provider?.publisher;
  if (!provider || !publisher) {
    return { ok: false, code: "publishing_unavailable" };
  }
  if (!publisher.supportedMediaKinds.includes(request.mediaKind)) {
    return { ok: false, code: "unsupported_media" };
  }
  if (!hasRequiredScopes(publisher.requiredScopes, account.scopes)) {
    return { ok: false, code: "missing_scope" };
  }

  // Les déclarations YouTube sont exigées À LA SAISIE. Les valider seulement à
  // l'exécution laisserait l'utilisateur croire sa publication programmée,
  // pour la voir échouer sans lui plus tard — c'est précisément ce qui se
  // passait avec le titre, que ce module ne conservait pas.
  let youtube: YouTubeMetadata | null = null;
  if (account.platform === "youtube") {
    const metadonnees = parseYouTubeMetadata(
      {
        title: request.title,
        privacyStatus: request.privacyStatus,
        madeForKids: request.madeForKids,
        guidelinesAcknowledged: request.guidelinesAcknowledged,
      },
      now,
    );
    if (!metadonnees.ok) {
      return { ok: false, code: metadonnees.code };
    }
    youtube = metadonnees.value;
  }


  // Média : on ne signe rien, mais on vérifie qu'il EXISTE, qu'il est prêt et
  // qu'il convient à ce réseau. C'est le contrôle qui a le plus de valeur ici,
  // parce qu'il serait autrement découvert à l'échéance.
  let storedReference = request.mediaUrl ?? "";
  let assetId: string | null = null;

  if (request.mediaAssetId) {
    const { data: asset } = await db
      .from("media_assets")
      .select("id, kind, status, storage_path, mime_type, width, height, duration_seconds, video_codec")
      .eq("id", request.mediaAssetId)
      .eq("workspace_id", request.workspaceId)
      .eq("status", "ready")
      .maybeSingle<AssetRow>();
    if (!asset) {
      return { ok: false, code: "media_not_found" };
    }
    // Même contrôle que la publication immédiate, y compris le TYPE de
    // publication : un média peut convenir en image et pas en Reel.
    const violations = checkMediaForPlatform(
      asset,
      account.platform as Parameters<typeof checkMediaForPlatform>[1],
      request.mediaKind,
      account.platform,
    );
    if (violations.length > 0) {
      return { ok: false, code: "media_incompatible" };
    }
    storedReference = asset.storage_path;
    assetId = asset.id;
  }

  // Quota du plan, compté sur le mois de l'ÉCHÉANCE : programmer pour février
  // consomme février. `effective_at` est une colonne générée, donc fiable.
  const { start, end } = currentMonthRange(new Date(echeance.iso).getTime());
  const [quota, { count }] = await Promise.all([
    deps.getMonthlyQuota(request.workspaceId),
    db
      .from("social_publications")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", request.workspaceId)
      .in("status", QUOTA_STATUSES as unknown as string[])
      .gte("effective_at", start)
      .lt("effective_at", end),
  ]);
  if ((count ?? 0) >= quota) {
    return { ok: false, code: "quota_exceeded" };
  }

  const { data: created, error } = await db
    .from("social_publications")
    .insert({
      workspace_id: request.workspaceId,
      social_account_id: account.id,
      platform: account.platform,
      provider_account_id: account.provider_account_id,
      media_kind: request.mediaKind,
      media_url: storedReference,
      media_asset_id: assetId,
      caption: request.caption,
      status: "scheduled",
      scheduled_at: echeance.iso,
      requested_by: request.requestedBy,
      title: youtube?.title ?? null,
      privacy_status: youtube?.privacyStatus ?? null,
      made_for_kids: youtube?.madeForKids ?? null,
      guidelines_acknowledged_at: youtube?.guidelinesAcknowledgedAt ?? null,
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !created) {
    console.error(`[social:schedule] insert: ${error?.code ?? "aucun id"}`);
    return { ok: false, code: "provider_error" };
  }
  return { ok: true, publicationId: created.id, scheduledAt: echeance.iso };
}

/**
 * Annule une publication encore programmée.
 *
 * Le filtre porte sur le statut : une publication déjà réclamée par le
 * planificateur (`pending`) est peut-être DÉJÀ partie chez la plateforme.
 * Prétendre l'annuler serait mentir — on refuse explicitement.
 */
export async function cancelScheduledPublication(
  db: SupabaseClient,
  input: { workspaceId: string; publicationId: string },
): Promise<{ ok: true } | { ok: false; code: "not_found" | "already_started" }> {
  const { data: existing } = await db
    .from("social_publications")
    .select("id, status")
    .eq("id", input.publicationId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle<{ id: string; status: string }>();
  if (!existing) {
    return { ok: false, code: "not_found" };
  }
  if (existing.status !== "scheduled") {
    return { ok: false, code: "already_started" };
  }

  // La condition sur le statut est REPRISE dans l'update : entre la lecture et
  // l'écriture, le planificateur a pu réclamer la ligne.
  const { data: updated } = await db
    .from("social_publications")
    .update({ status: "canceled", status_detail: "canceled_by_user" })
    .eq("id", input.publicationId)
    .eq("workspace_id", input.workspaceId)
    .eq("status", "scheduled")
    .select("id");

  if (!updated || updated.length === 0) {
    return { ok: false, code: "already_started" };
  }
  return { ok: true };
}


/**
 * Déplace l'échéance d'une publication encore programmée.
 *
 * POURQUOI CETTE FONCTION EXISTE. Sans elle, changer l'heure d'une publication
 * imposait de l'annuler puis de tout ressaisir — média, texte, compte cible —
 * alors que rien de tout cela ne change. C'est le genre de détour qui pousse à
 * ne plus programmer du tout.
 *
 * LES MÊMES GARDES QU'À LA CRÉATION, et pour les mêmes raisons. La nouvelle
 * échéance repasse par `validateScheduledAt` : une publication déplacée dans
 * le passé, ou dans deux ans, ne serait pas plus tenable qu'à la création.
 *
 * ET LE MÊME REFUS QU'À L'ANNULATION. Une publication déjà réclamée par le
 * planificateur (`pending`) est peut-être en route chez la plateforme :
 * déplacer son échéance ne la rappellerait pas, cela ferait seulement mentir
 * le calendrier. La condition sur le statut est donc REPRISE dans l'écriture —
 * entre la lecture et la mise à jour, le planificateur a pu réclamer la ligne.
 */
export async function reschedulePublication(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    publicationId: string;
    scheduledAt: string;
    now?: () => number;
  },
): Promise<
  | { ok: true; scheduledAt: string }
  | { ok: false; code: "not_found" | "already_started" | ScheduleFailureCode }
> {
  const maintenant = (input.now ?? Date.now)();

  const echeance = validateScheduledAt(input.scheduledAt, maintenant);
  if (!echeance.ok) {
    return echeance;
  }

  const { data: existing } = await db
    .from("social_publications")
    .select("id, status")
    .eq("id", input.publicationId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle<{ id: string; status: string }>();
  if (!existing) {
    return { ok: false, code: "not_found" };
  }
  if (existing.status !== "scheduled") {
    return { ok: false, code: "already_started" };
  }

  const { data: updated } = await db
    .from("social_publications")
    .update({ scheduled_at: echeance.iso })
    .eq("id", input.publicationId)
    .eq("workspace_id", input.workspaceId)
    .eq("status", "scheduled")
    .select("id");

  if (!updated || updated.length === 0) {
    return { ok: false, code: "already_started" };
  }
  return { ok: true, scheduledAt: echeance.iso };
}

/** Scopes réellement accordés au compte, et non ceux demandés à l'origine. */
function hasRequiredScopes(required: readonly string[], granted: string[] | null): boolean {
  const accordes = new Set(granted ?? []);
  return required.every((scope) => accordes.has(scope));
}
