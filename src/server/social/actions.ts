"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getSiteOrigin } from "@/lib/site-url";
import { listMemberships, requireUser } from "@/features/workspaces/queries";
import { findMembershipBySlug } from "@/features/workspaces/resolve";
import { getWorkspaceAccess } from "@/server/billing/queries";
import { createServiceClient } from "@/server/supabase/service-client";
import type { SocialPlatform } from "@/types/platform";
import type { WorkspaceMembership } from "@/types/workspace";

import { canConnectMore, PLATFORM_LABELS } from "./accounts";
import { connectSelectedAssets, type AssetsFailureCode } from "./assets";
import type { PublishActionState, SocialActionState } from "./action-state";
import {
  publishToSocialAccount,
  resumePublication,
  type PublishFailureCode,
} from "./publish";
import type { PublishMediaKind } from "./providers/types";
import { createOAuthState } from "./oauth-state";
import { getProvider } from "./providers";
import { vaultRead } from "./vault";

/**
 * Server Actions des comptes sociaux.
 *
 * Chaîne de sécurité (identique au billing C7) :
 *   1. session revalidée + compte actif (`requireUser`) ;
 *   2. workspace résolu par SLUG contre les memberships réelles sous RLS ;
 *   3. seuls `owner` et `admin` connectent/déconnectent ; un member lit ;
 *   4. le navigateur n'envoie que slug + plateforme (+ id de compte pour la
 *      déconnexion, revérifié contre le workspace) ;
 *   5. quota `socialAccounts` du plan (C7) appliqué à la connexion.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORMS: readonly SocialPlatform[] = ["instagram", "facebook", "tiktok", "youtube"];
const NOT_ALLOWED =
  "Seul le propriétaire ou un admin du workspace peut gérer les comptes sociaux.";

function isPlatform(value: string): value is SocialPlatform {
  return (PLATFORMS as readonly string[]).includes(value);
}

async function requireSocialManager(formData: FormData): Promise<
  { ok: true; membership: WorkspaceMembership } | { ok: false; error: string }
> {
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

/** Démarre (ou redémarre, pour une reconnexion) le flux OAuth d'une plateforme. */
export async function startConnectAction(
  _prev: SocialActionState,
  formData: FormData,
): Promise<SocialActionState> {
  const auth = await requireSocialManager(formData);
  if (!auth.ok) {
    return { error: auth.error };
  }

  const platformRaw = String(formData.get("platform") ?? "");
  if (!isPlatform(platformRaw)) {
    return { error: "Plateforme invalide." };
  }
  const provider = getProvider(platformRaw);
  if (!provider) {
    return {
      error: `L'intégration ${PLATFORM_LABELS[platformRaw]} arrive dans une prochaine étape.`,
    };
  }

  const { workspace } = auth.membership;
  const { supabase, user } = await requireUser();
  const db = createServiceClient();

  // Reconnexion (`accountId` fourni) : jamais bloquée par le quota — le
  // callback mettra à jour la ligne existante. Connexion nouvelle : quota.
  const isReconnect = UUID.test(String(formData.get("accountId") ?? ""));
  if (!isReconnect) {
    const [{ access }, { count }] = await Promise.all([
      getWorkspaceAccess(supabase, workspace.id),
      db
        .from("social_accounts")
        .select("*", { count: "exact", head: true })
        .eq("workspace_id", workspace.id),
    ]);
    if (!canConnectMore(count ?? 0, access.quotas.socialAccounts)) {
      return {
        error:
          `Limite de ${access.quotas.socialAccounts} compte(s) social(aux) atteinte pour le plan ` +
          `${access.plan.name}. Passez à un plan supérieur ou déconnectez un compte.`,
      };
    }
  }

  let authUrl: string;
  try {
    const { state, codeChallenge } = await createOAuthState(db, {
      workspaceId: workspace.id,
      userId: user.id,
      platform: platformRaw,
      redirectSlug: workspace.slug,
      usePkce: provider.usesPkce,
    });
    const origin = await getSiteOrigin();
    authUrl = provider.buildAuthUrl({
      state,
      codeChallenge,
      redirectUri: `${origin}/api/oauth/${platformRaw}/callback`,
    });
  } catch (error) {
    console.error(
      `[social:connect] ${error instanceof Error ? error.message : "erreur inconnue"}`,
    );
    return { error: "Impossible de démarrer la connexion. Veuillez réessayer." };
  }
  redirect(authUrl);
}

/** Déconnecte un compte social : révocation best effort, purge Vault (trigger), audit propre. */
export async function disconnectAction(
  _prev: SocialActionState,
  formData: FormData,
): Promise<SocialActionState> {
  const auth = await requireSocialManager(formData);
  if (!auth.ok) {
    return { error: auth.error };
  }
  const accountId = String(formData.get("accountId") ?? "");
  if (!UUID.test(accountId)) {
    return { error: "Compte invalide." };
  }

  const db = createServiceClient();
  // Le compte doit appartenir AU workspace autorisé — jamais confiance à l'id seul.
  const { data: account } = await db
    .from("social_accounts")
    .select("id, platform, access_token_id, refresh_token_id")
    .eq("id", accountId)
    .eq("workspace_id", auth.membership.workspace.id)
    .maybeSingle();
  if (!account) {
    return { error: "Compte introuvable." };
  }

  // Révocation côté plateforme : best effort, jamais bloquante.
  const provider = getProvider(account.platform as SocialPlatform);
  if (provider?.revoke) {
    try {
      const [accessToken, refreshToken] = await Promise.all([
        account.access_token_id ? vaultRead(db, account.access_token_id) : null,
        account.refresh_token_id ? vaultRead(db, account.refresh_token_id) : null,
      ]);
      await provider.revoke({ accessToken, refreshToken });
    } catch {
      // La déconnexion locale prime : un échec de révocation distante n'empêche rien.
    }
  }

  // La suppression déclenche la purge Vault (trigger C8.1).
  const { error } = await db.from("social_accounts").delete().eq("id", account.id);
  if (error) {
    console.error(`[social:disconnect] ${error.code}`);
    return { error: "La déconnexion a échoué. Veuillez réessayer." };
  }

  revalidatePath(`/app/${auth.membership.workspace.slug}/accounts`);

  // Plateforme sans révocation possible côté application (Instagram) :
  // l'utilisateur doit retirer l'autorisation lui-même, il faut le lui dire.
  // Le message est porté au niveau de la PAGE et non du bouton : la ligne
  // vient d'être supprimée, le formulaire n'est donc plus monté.
  if (provider && !provider.revoke && provider.revokeNotice) {
    redirect(
      `/app/${auth.membership.workspace.slug}/accounts` +
        `?notice=manual_revoke&platform=${encodeURIComponent(account.platform)}`,
    );
  }
  return { error: null };
}


// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

/**
 * Messages d'échec. Les codes viennent de `publish.ts` et ne contiennent
 * jamais de token ni de réponse brute de la plateforme.
 */
const PUBLISH_ERRORS: Record<PublishFailureCode, string> = {
  invalid_media_url:
    "L'URL du média doit être une adresse https publique, directement accessible par la plateforme.",
  caption_too_long: "La légende dépasse 2200 caractères.",
  unsupported_media: "Ce type de média n'est pas encore pris en charge pour cette plateforme.",
  account_not_found: "Compte introuvable.",
  publishing_unavailable: "La publication n'est pas encore disponible pour cette plateforme.",
  missing_scope:
    "Ce compte a été connecté avant l'activation de la publication. Reconnectez-le pour autoriser la publication.",
  account_inactive: "Ce compte doit être reconnecté avant de publier.",
  quota_exceeded:
    "Limite de publications du plan atteinte pour ce mois-ci. Passez à un plan supérieur.",
  token_unavailable: "L'autorisation de ce compte est indisponible. Reconnectez-le.",
  needs_reconnect:
    "L'autorisation de ce compte n'a pas pu être renouvelée auprès de la plateforme. Reconnectez-le.",
  container_failed: "La plateforme a rejeté le média. Vérifiez son format et sa durée.",
  container_expired:
    "Le média préparé a expiré côté plateforme (24 h). Relancez la publication.",
  provider_error: "La plateforme n'a pas accepté la publication. Réessayez.",
};

const MEDIA_KINDS: readonly PublishMediaKind[] = ["reel", "image"];

function isMediaKind(value: string): value is PublishMediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(value);
}

/** Dépendances communes aux deux actions de publication. */
function publishDeps(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"]) {
  const db = createServiceClient();
  return {
    db,
    getProvider: (platform: string) => getProvider(platform as SocialPlatform),
    getMonthlyQuota: async (workspaceId: string) => {
      const { access } = await getWorkspaceAccess(supabase, workspaceId);
      return access.quotas.publicationsPerMonth;
    },
  };
}

/** Publie un média sur un compte social connecté du workspace. */
export async function publishAction(
  _prev: PublishActionState,
  formData: FormData,
): Promise<PublishActionState> {
  const auth = await requireSocialManager(formData);
  if (!auth.ok) {
    return { error: auth.error, status: null, permalink: null, publicationId: null };
  }

  const accountId = String(formData.get("accountId") ?? "");
  if (!UUID.test(accountId)) {
    return { error: "Compte invalide.", status: null, permalink: null, publicationId: null };
  }
  const mediaKindRaw = String(formData.get("mediaKind") ?? "reel");
  if (!isMediaKind(mediaKindRaw)) {
    return { error: "Type de média invalide.", status: null, permalink: null, publicationId: null };
  }
  const caption = String(formData.get("caption") ?? "").trim();

  const { supabase, user } = await requireUser();
  const outcome = await publishToSocialAccount(publishDeps(supabase), {
    workspaceId: auth.membership.workspace.id,
    socialAccountId: accountId,
    requestedBy: user.id,
    mediaKind: mediaKindRaw,
    mediaUrl: String(formData.get("mediaUrl") ?? "").trim(),
    caption: caption.length > 0 ? caption : null,
    shareToFeed: formData.get("shareToFeed") === "on",
  });

  revalidatePath(`/app/${auth.membership.workspace.slug}/accounts`);

  if (!outcome.ok) {
    return {
      error: PUBLISH_ERRORS[outcome.code],
      status: null,
      permalink: null,
      publicationId: outcome.publicationId,
    };
  }
  return {
    error: null,
    status: outcome.status,
    permalink: outcome.status === "published" ? outcome.permalink : null,
    publicationId: outcome.publicationId,
  };
}

/**
 * Reprend une publication laissée en cours : le conteneur distant reste
 * valide 24 h, le média n'est jamais réenvoyé.
 */
export async function resumePublicationAction(
  _prev: PublishActionState,
  formData: FormData,
): Promise<PublishActionState> {
  const auth = await requireSocialManager(formData);
  if (!auth.ok) {
    return { error: auth.error, status: null, permalink: null, publicationId: null };
  }
  const publicationId = String(formData.get("publicationId") ?? "");
  if (!UUID.test(publicationId)) {
    return { error: "Publication invalide.", status: null, permalink: null, publicationId: null };
  }

  const { supabase } = await requireUser();
  const outcome = await resumePublication(publishDeps(supabase), {
    workspaceId: auth.membership.workspace.id,
    publicationId,
  });

  revalidatePath(`/app/${auth.membership.workspace.slug}/accounts`);

  if (!outcome.ok) {
    return {
      error: PUBLISH_ERRORS[outcome.code],
      status: null,
      permalink: null,
      publicationId: outcome.publicationId,
    };
  }
  return {
    error: null,
    status: outcome.status,
    permalink: outcome.status === "published" ? outcome.permalink : null,
    publicationId: outcome.publicationId,
  };
}


// ---------------------------------------------------------------------------
// Sélection d'actifs (Pages Facebook)
// ---------------------------------------------------------------------------

const ASSET_ERRORS: Record<AssetsFailureCode, string> = {
  draft_not_found:
    "Cette demande de connexion a expiré ou a déjà été utilisée. Relancez la connexion.",
  provider_unavailable: "Cette plateforme n'est pas disponible actuellement.",
  listing_failed:
    "Impossible de récupérer vos Pages auprès de la plateforme. Réessayez.",
  nothing_selected: "Sélectionnez au moins une Page.",
  not_publishable:
    "Vous ne pouvez pas publier sur l'une des Pages sélectionnées. Demandez la permission de création de contenu, puis réessayez.",
  quota_exceeded:
    "Le nombre de Pages sélectionnées dépasse la limite de comptes de votre plan.",
  connect_failed: "La connexion des Pages a échoué. Réessayez.",
};

/**
 * Connecte les Pages cochées par l'utilisateur. Le navigateur n'envoie que
 * des identifiants d'actifs ; tout est revérifié côté serveur contre le
 * brouillon, qui est lui-même lié au workspace ET à l'utilisateur.
 */
export async function connectAssetsAction(
  _prev: SocialActionState,
  formData: FormData,
): Promise<SocialActionState> {
  const auth = await requireSocialManager(formData);
  if (!auth.ok) {
    return { error: auth.error };
  }

  const draftId = String(formData.get("draftId") ?? "");
  if (!UUID.test(draftId)) {
    return { error: "Demande de connexion invalide." };
  }
  const assetIds = formData
    .getAll("assetIds")
    .map((value) => String(value))
    .filter((value) => value.length > 0 && value.length <= 128);

  const { supabase, user } = await requireUser();
  const db = createServiceClient();

  const result = await connectSelectedAssets(
    {
      db,
      getProvider: (platform: string) => getProvider(platform as SocialPlatform),
      getQuota: async (workspaceId: string) => {
        const { access } = await getWorkspaceAccess(supabase, workspaceId);
        return access.quotas.socialAccounts;
      },
    },
    {
      draftId,
      workspaceId: auth.membership.workspace.id,
      userId: user.id,
      assetIds,
    },
  );

  if (!result.ok) {
    return { error: ASSET_ERRORS[result.code] };
  }

  revalidatePath(`/app/${auth.membership.workspace.slug}/accounts`);
  redirect(`/app/${auth.membership.workspace.slug}/accounts?connected=facebook`);
}
