import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  SocialPublishError,
  type ContainerStatus,
  type PublishMediaKind,
  type SocialProvider,
} from "./providers/types";
import { signMediaUrl } from "@/server/media/library";
import { checkMediaForPlatform } from "@/server/media/rules";

import { getUsableAccessToken } from "./token";

/**
 * Orchestration de la publication sociale.
 *
 * Le provider ne sait qu'appeler la plateforme. Tout ce qui engage POSTYNC
 * vit ici, et dans cet ordre — aucune étape n'est optionnelle :
 *
 *   1. le média est décrit par une URL PUBLIQUE en https (Instagram va la
 *      chercher lui-même ; aucun upload direct n'existe dans cette API) ;
 *   2. le compte social appartient bien AU WORKSPACE demandé — jamais
 *      confiance à un identifiant venu du navigateur ;
 *   3. le compte a RÉELLEMENT accordé le scope de publication (un compte
 *      connecté avant l'ajout du scope ne l'a pas : reconnexion demandée) ;
 *   4. le quota `publicationsPerMonth` du plan (C7, Full Access compris) est
 *      vérifié AVANT tout appel distant ;
 *   5. le token n'est lu dans Vault qu'à ce moment, reste en mémoire serveur,
 *      et n'est ni journalisé ni renvoyé au navigateur.
 *
 * La publication est asynchrone par nature : Instagram transcode un Reel
 * avant de le rendre publiable, et le conteneur reste valide 24 h. On attend
 * donc pendant un budget borné, puis on laisse la ligne en `pending` avec son
 * `container_id`. `resumePublication` reprend ce conteneur — on ne renvoie
 * JAMAIS le média une seconde fois.
 */

/** Attente maximale dans une requête (la publication continue côté Meta). */
const POLL_BUDGET_MS = 45_000;
/** Palier d'attente : court au début (une image est prête tout de suite). */
const POLL_STEPS_MS = [1_000, 2_000, 3_000, 5_000, 8_000, 10_000];

export type PublishOutcome =
  | { ok: true; publicationId: string; status: "published"; permalink: string | null }
  | { ok: true; publicationId: string; status: "pending" }
  | { ok: false; code: PublishFailureCode; publicationId: string | null };

export type PublishFailureCode =
  | "invalid_media_url"
  | "media_not_found"
  | "media_incompatible"
  | "caption_too_long"
  | "unsupported_media"
  | "account_not_found"
  | "publishing_unavailable"
  | "missing_scope"
  | "account_inactive"
  | "quota_exceeded"
  | "token_unavailable"
  | "needs_reconnect"
  | "container_failed"
  | "container_expired"
  | "provider_error";

export type PublishRequest = {
  workspaceId: string;
  socialAccountId: string;
  requestedBy: string;
  mediaKind: PublishMediaKind;
  /**
   * Média de la médiathèque. Quand il est fourni, l'URL remise à la
   * plateforme est SIGNÉE ICI, au moment de publier, et n'est jamais
   * conservée : la ligne ne garde que la clé de l'objet.
   */
  mediaAssetId?: string | null;
  /**
   * Chemin historique : URL publique saisie à la main. Conservé tant que la
   * médiathèque ne l'a pas entièrement remplacé.
   */
  mediaUrl?: string;
  caption: string | null;
  coverUrl?: string | null;
  shareToFeed?: boolean;
  /**
   * Publication DÉJÀ existante à mener à son terme (C10.2).
   *
   * Le planificateur a réclamé une ligne `scheduled` et l'a fait passer en
   * `pending` — atomiquement, c'est ce qui garantit qu'elle ne partira pas
   * deux fois. On ne doit donc surtout pas en créer une seconde : elle
   * porterait un quota supplémentaire et briserait la trace.
   *
   * Absent, le comportement est celui d'avant, inchangé : quota vérifié puis
   * ligne créée.
   */
  existingPublicationId?: string | null;
};

/** D'où vient le média, une fois la source résolue. */
type ResolvedMedia = {
  /** URL que la plateforme ira chercher. Éphémère si elle est signée. */
  remoteUrl: string;
  /** Ce qui sera ENREGISTRÉ : clé de l'objet, ou URL manuelle. */
  storedReference: string;
  assetId: string | null;
};

export type PublishDeps = {
  /** Client service_role : écritures et Vault. */
  db: SupabaseClient;
  getProvider: (platform: string) => SocialProvider | null;
  /** Quota `publicationsPerMonth` du plan du workspace. */
  getMonthlyQuota: (workspaceId: string) => Promise<number>;
  /** Injectable pour les tests : aucune attente réelle. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Attente maximale du conteneur. Défaut : `POLL_BUDGET_MS`, inchangé.
   *
   * Le planificateur en demande un plus COURT (C10.2) : il traite un lot et
   * doit rendre la main vite. Une publication non aboutie reste `pending`
   * avec son conteneur, et le réveil suivant la reprend — jamais réenvoyée,
   * jamais republiée.
   */
  pollBudgetMs?: number;
};

const CAPTION_MAX_LENGTH = 2200;

/**
 * Le média doit être joignable publiquement par Meta. On impose https :
 * une URL http serait refusée ou dégradée, et tout autre schéma n'a aucun
 * sens ici. Aucune requête n'est faite par POSTYNC vers cette URL.
 */
export function isPublishableMediaUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // Une URL portant des identifiants (https://user:pass@…) ne doit pas être
  // transmise à un tiers.
  if (url.username || url.password) return false;
  return url.hostname.length > 0;
}

/** Bornes du mois calendaire courant, en UTC. */
export function currentMonthRange(now: number): { start: string; end: string } {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/**
 * Statuts qui consomment le quota mensuel du plan.
 *
 * `failed` et `canceled` ne comptent pas : on ne facture pas un échec ni un
 * renoncement. `scheduled` compte, en revanche — sans quoi il suffirait de
 * tout programmer pour publier sans limite, et le quota ne voudrait plus rien
 * dire.
 */
export const QUOTA_STATUSES = ["published", "pending", "scheduled"] as const;

export function countsTowardQuota(status: string): boolean {
  return (QUOTA_STATUSES as readonly string[]).includes(status);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type AccountRow = {
  id: string;
  workspace_id: string;
  platform: string;
  provider_account_id: string;
  scopes: string[] | null;
  status: string;
  access_token_id: string | null;
  refresh_token_id: string | null;
  token_expires_at: string | null;
};

/** Erreur courte, jamais de token ni de payload brut. */
function shortCode(error: unknown): string {
  if (error instanceof SocialPublishError) return error.code;
  return "provider_error";
}

async function markFailed(
  db: SupabaseClient,
  publicationId: string,
  detail: string,
): Promise<void> {
  await db
    .from("social_publications")
    .update({ status: "failed", status_detail: detail.slice(0, 120) })
    .eq("id", publicationId);
}

/**
 * Attend qu'un conteneur devienne publiable, dans un budget borné.
 * Retourne le dernier statut observé.
 */
async function waitForContainer(
  provider: SocialProvider,
  input: { accessToken: string; containerId: string },
  deps: PublishDeps,
): Promise<ContainerStatus> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const publisher = provider.publisher!;
  const deadline = now() + (deps.pollBudgetMs ?? POLL_BUDGET_MS);

  let status = await publisher.containerStatus(input);
  let step = 0;
  while (status === "processing" && now() < deadline) {
    await sleep(POLL_STEPS_MS[Math.min(step, POLL_STEPS_MS.length - 1)]);
    step += 1;
    status = await publisher.containerStatus(input);
  }
  return status;
}

/**
 * Publie le conteneur puis met la ligne à jour. Facteur commun entre la
 * publication initiale et la reprise.
 */
async function finishPublication(
  provider: SocialProvider,
  deps: PublishDeps,
  input: {
    publicationId: string;
    accessToken: string;
    providerAccountId: string;
    containerId: string;
    status: ContainerStatus;
    /** Portée jusqu'ici : Facebook la pose à la publication, pas au conteneur. */
    caption: string | null;
  },
): Promise<PublishOutcome> {
  const publisher = provider.publisher!;
  const { publicationId, accessToken, providerAccountId, containerId } = input;

  if (input.status === "processing") {
    // Le traitement se poursuit chez Meta : la ligne reste reprenable.
    return { ok: true, publicationId, status: "pending" };
  }
  if (input.status === "expired") {
    await markFailed(deps.db, publicationId, "container_expired");
    return { ok: false, code: "container_expired", publicationId };
  }
  if (input.status === "failed") {
    await markFailed(deps.db, publicationId, "container_failed");
    return { ok: false, code: "container_failed", publicationId };
  }

  let providerMediaId: string;
  // Cas limite : la plateforme dit le conteneur DÉJÀ publié (notre appel a
  // abouti mais sa réponse s'est perdue). Republier créerait un doublon sur
  // le compte de l'utilisateur. On enregistre donc la publication, mais sans
  // prétendre connaître l'identifiant du média : la référence conservée est
  // celle du conteneur, et `status_detail` le signale explicitement.
  let detail: string | null = null;
  if (input.status === "published") {
    providerMediaId = containerId;
    detail = "media_id_is_container";
  } else {
    try {
      ({ providerMediaId } = await publisher.publishContainer({
        accessToken,
        providerAccountId,
        containerId,
        caption: input.caption,
      }));
    } catch (error) {
      const code = shortCode(error);
      console.error(`[social:publish] ${provider.platform} media_publish: ${code}`);
      await markFailed(deps.db, publicationId, code);
      return { ok: false, code: "provider_error", publicationId };
    }
  }

  // Permalien : confort d'affichage, jamais bloquant.
  let permalink: string | null = null;
  if (publisher.fetchPermalink && detail === null) {
    permalink = await publisher
      .fetchPermalink({ accessToken, providerMediaId })
      .catch(() => null);
  }

  await deps.db
    .from("social_publications")
    .update({
      status: "published",
      provider_media_id: providerMediaId,
      permalink,
      published_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
      status_detail: detail,
    })
    .eq("id", publicationId);

  return { ok: true, publicationId, status: "published", permalink };
}

/**
 * Publication complète : contrôles, création du conteneur, attente bornée,
 * publication. L'APPELANT a déjà vérifié la session et le rôle owner/admin.
 */
export async function publishToSocialAccount(
  deps: PublishDeps,
  request: PublishRequest,
): Promise<PublishOutcome> {
  const { db } = deps;

  if (request.caption && request.caption.length > CAPTION_MAX_LENGTH) {
    return { ok: false, code: "caption_too_long", publicationId: null };
  }
  if (request.coverUrl && !isPublishableMediaUrl(request.coverUrl)) {
    return { ok: false, code: "invalid_media_url", publicationId: null };
  }
  // La source du média n'est résolue qu'ici : dans le cas médiathèque, cela
  // évite de signer une URL pour une publication qui sera refusée ensuite.
  if (!request.mediaAssetId && !isPublishableMediaUrl(request.mediaUrl ?? "")) {
    return { ok: false, code: "invalid_media_url", publicationId: null };
  }

  // Le compte doit appartenir au workspace demandé : le filtre porte sur les
  // DEUX colonnes, un identifiant volé ne suffit pas.
  const { data: account } = await db
    .from("social_accounts")
    .select(
      "id, workspace_id, platform, provider_account_id, scopes, status, " +
        "access_token_id, refresh_token_id, token_expires_at",
    )
    .eq("id", request.socialAccountId)
    .eq("workspace_id", request.workspaceId)
    .maybeSingle<AccountRow>();
  if (!account) {
    return { ok: false, code: "account_not_found", publicationId: null };
  }
  if (account.status !== "active") {
    return { ok: false, code: "account_inactive", publicationId: null };
  }

  const provider = deps.getProvider(account.platform);
  const publisher = provider?.publisher;
  if (!provider || !publisher) {
    return { ok: false, code: "publishing_unavailable", publicationId: null };
  }
  if (!publisher.supportedMediaKinds.includes(request.mediaKind)) {
    return { ok: false, code: "unsupported_media", publicationId: null };
  }

  // Scopes RÉELLEMENT accordés : un compte connecté avant l'ajout du scope de
  // publication doit être reconnecté, on ne tente pas un appel voué à l'échec.
  const granted = new Set(account.scopes ?? []);
  if (!publisher.requiredScopes.every((scope) => granted.has(scope))) {
    return { ok: false, code: "missing_scope", publicationId: null };
  }

  // Quota du plan, AVANT tout appel distant.
  //
  // Une publication programmée l'a DÉJÀ consommé à la saisie : la recompter
  // ici la ferait échouer contre elle-même, puisqu'elle figure dans le
  // décompte. On ne revérifie donc que pour une publication nouvelle.
  const now = deps.now ?? Date.now;
  if (!request.existingPublicationId) {
    const { start, end } = currentMonthRange(now());
    const [quota, { count }] = await Promise.all([
      deps.getMonthlyQuota(request.workspaceId),
      db
        .from("social_publications")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", request.workspaceId)
        .in("status", QUOTA_STATUSES as unknown as string[])
        // `effective_at` et non `created_at` : une publication programmée
        // consomme le quota du mois où elle PARAÎT, pas de celui où on l'a
        // saisie. Colonne générée, donc toujours cohérente.
        .gte("effective_at", start)
        .lt("effective_at", end),
    ]);
    if ((count ?? 0) >= quota) {
      return { ok: false, code: "quota_exceeded", publicationId: null };
    }
  }

  // Source du média. Pour la médiathèque : vérification de compatibilité avec
  // CETTE plateforme, puis signature — dans cet ordre, pour ne jamais forger
  // d'URL au profit d'une publication vouée à être refusée.
  let media: ResolvedMedia;
  if (request.mediaAssetId) {
    const { data: asset } = await db
      .from("media_assets")
      .select("id, storage_path, mime_type, kind, width, height, duration_seconds, status")
      .eq("id", request.mediaAssetId)
      .eq("workspace_id", request.workspaceId)
      .maybeSingle<{
        id: string;
        storage_path: string;
        mime_type: string;
        kind: "video" | "image";
        width: number | null;
        height: number | null;
        duration_seconds: number | null;
        status: string;
      }>();
    if (!asset) {
      return { ok: false, code: "media_not_found", publicationId: null };
    }
    if (asset.status !== "ready") {
      return { ok: false, code: "media_not_found", publicationId: null };
    }

    const violations = checkMediaForPlatform(
      asset,
      account.platform as Parameters<typeof checkMediaForPlatform>[1],
      request.mediaKind,
      account.platform,
    );
    if (violations.length > 0) {
      return { ok: false, code: "media_incompatible", publicationId: null };
    }

    const signed = await signMediaUrl(db, {
      workspaceId: request.workspaceId,
      assetId: asset.id,
    });
    if (!signed.ok) {
      return { ok: false, code: "media_not_found", publicationId: null };
    }
    media = {
      remoteUrl: signed.url,
      // Ce qui est enregistré est la CLÉ, jamais l'URL signée.
      storedReference: asset.storage_path,
      assetId: asset.id,
    };
  } else {
    media = {
      remoteUrl: request.mediaUrl as string,
      storedReference: request.mediaUrl as string,
      assetId: null,
    };
  }

  // Le jeton est renouvelé si nécessaire AVANT la publication : un jeton qui
  // expire au milieu d'un transfert serait pire qu'un jeton déjà expiré.
  const token = await getUsableAccessToken({ db, now }, provider, account);
  if (!token.ok) {
    return { ok: false, code: token.code, publicationId: null };
  }
  const accessToken = token.accessToken;

  // La ligne existe AVANT l'appel distant : une publication réellement partie
  // ne peut pas rester sans trace, et elle consomme le quota.
  let publicationId: string;

  if (request.existingPublicationId) {
    // Publication programmée, déjà réclamée par le planificateur. Le filtre
    // sur `status = 'pending'` est essentiel : il n'accepte QUE la ligne que
    // la réclamation atomique vient de nous attribuer. Si elle a été annulée,
    // reprise ailleurs ou déjà publiée entre-temps, rien ne correspond et on
    // s'arrête avant tout appel distant — c'est ce qui interdit la double
    // publication jusqu'ici.
    const { data: adoptee, error: adoptError } = await db
      .from("social_publications")
      .update({ media_url: media.storedReference, media_asset_id: media.assetId })
      .eq("id", request.existingPublicationId)
      .eq("workspace_id", request.workspaceId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle<{ id: string }>();
    if (adoptError || !adoptee) {
      console.error(`[social:publish] adoption: ${adoptError?.code ?? "ligne non réclamable"}`);
      return { ok: false, code: "provider_error", publicationId: request.existingPublicationId };
    }
    publicationId = adoptee.id;
  } else {
    const { data: created, error: insertError } = await db
      .from("social_publications")
      .insert({
        workspace_id: request.workspaceId,
        social_account_id: account.id,
        platform: account.platform,
        provider_account_id: account.provider_account_id,
        media_kind: request.mediaKind,
        media_url: media.storedReference,
        media_asset_id: media.assetId,
        caption: request.caption,
        requested_by: request.requestedBy,
        status: "pending",
      })
      .select("id")
      .single<{ id: string }>();
    if (insertError || !created) {
      console.error(`[social:publish] insert: ${insertError?.code ?? "inconnu"}`);
      return { ok: false, code: "provider_error", publicationId: null };
    }
    publicationId = created.id;
  }

  let containerId: string;
  try {
    containerId = await publisher.createContainer({
      accessToken,
      providerAccountId: account.provider_account_id,
      mediaKind: request.mediaKind,
      mediaUrl: media.remoteUrl,
      caption: request.caption,
      coverUrl: request.coverUrl ?? null,
      shareToFeed: request.shareToFeed,
    });
  } catch (error) {
    const code = shortCode(error);
    console.error(`[social:publish] ${account.platform} container: ${code}`);
    await markFailed(db, publicationId, code);
    return { ok: false, code: "provider_error", publicationId: publicationId };
  }

  await db.from("social_publications").update({ container_id: containerId }).eq("id", publicationId);

  let status: ContainerStatus;
  try {
    status = await waitForContainer(provider, { accessToken, containerId }, deps);
  } catch (error) {
    const code = shortCode(error);
    console.error(`[social:publish] ${account.platform} status: ${code}`);
    // Le conteneur existe : la ligne reste reprenable plutôt que perdue.
    return { ok: true, publicationId: publicationId, status: "pending" };
  }

  return finishPublication(provider, deps, {
    publicationId: publicationId,
    accessToken,
    providerAccountId: account.provider_account_id,
    containerId,
    status,
    caption: request.caption,
  });
}

/**
 * Reprend une publication restée `pending` : on interroge le conteneur
 * existant et on publie s'il est prêt. Le média n'est jamais réenvoyé.
 */
export async function resumePublication(
  deps: PublishDeps,
  input: { workspaceId: string; publicationId: string },
): Promise<PublishOutcome> {
  const { db } = deps;

  const { data: publication } = await db
    .from("social_publications")
    .select("id, workspace_id, platform, provider_account_id, container_id, status, social_account_id, caption")
    .eq("id", input.publicationId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle<{
      id: string;
      workspace_id: string;
      platform: string;
      provider_account_id: string;
      container_id: string | null;
      status: string;
      social_account_id: string | null;
      caption: string | null;
    }>();
  if (!publication) {
    return { ok: false, code: "account_not_found", publicationId: null };
  }
  if (publication.status !== "pending" || !publication.container_id) {
    return { ok: false, code: "container_failed", publicationId: publication.id };
  }

  const provider = deps.getProvider(publication.platform);
  if (!provider?.publisher) {
    return { ok: false, code: "publishing_unavailable", publicationId: publication.id };
  }

  // Le compte est relu maintenant : il a pu être déconnecté entre-temps.
  // `social_account_id` passe alors à null (on delete set null) : sans token,
  // il n'y a plus rien à reprendre.
  if (!publication.social_account_id) {
    return { ok: false, code: "token_unavailable", publicationId: publication.id };
  }
  const { data: account } = await db
    .from("social_accounts")
    .select(
      "id, workspace_id, platform, provider_account_id, scopes, status, " +
        "access_token_id, refresh_token_id, token_expires_at",
    )
    .eq("id", publication.social_account_id)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle<AccountRow>();
  if (!account) {
    return { ok: false, code: "token_unavailable", publicationId: publication.id };
  }

  const token = await getUsableAccessToken({ db, now: deps.now }, provider, account);
  if (!token.ok) {
    return { ok: false, code: token.code, publicationId: publication.id };
  }
  const accessToken = token.accessToken;

  let status: ContainerStatus;
  try {
    status = await waitForContainer(
      provider,
      { accessToken, containerId: publication.container_id },
      deps,
    );
  } catch (error) {
    console.error(`[social:publish] ${publication.platform} resume: ${shortCode(error)}`);
    return { ok: true, publicationId: publication.id, status: "pending" };
  }

  return finishPublication(provider, deps, {
    publicationId: publication.id,
    accessToken,
    providerAccountId: publication.provider_account_id,
    containerId: publication.container_id,
    status,
    // La légende vient de la ligne : une reprise ne perd pas le texte.
    caption: publication.caption,
  });
}
