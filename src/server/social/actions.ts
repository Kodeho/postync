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
import type { SocialActionState } from "./action-state";
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
  return { error: null };
}
