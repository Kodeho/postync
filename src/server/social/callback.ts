import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { canConnectMore } from "./accounts";
import { consumeOAuthState } from "./oauth-state";
import type { SocialProvider } from "./providers/types";
import { vaultDelete, vaultStore } from "./vault";

/**
 * Traitement générique d'un callback OAuth (`GET /api/oauth/[provider]/callback`).
 *
 * Vérifications, dans l'ordre — TOUTES obligatoires :
 *   1. `state` présent, connu (par hachage), non expiré, non consommé —
 *      consommation ATOMIQUE : un REPLAY du callback échoue (`invalid_state`) ;
 *   2. plateforme du state = plateforme de la route ;
 *   3. session navigateur présente et = UTILISATEUR INITIATEUR du state —
 *      un utilisateur du workspace A ne peut pas terminer un flux visant le
 *      workspace B : le state contient le workspace choisi côté serveur, et
 *      l'appelant doit être ce même utilisateur ;
 *   4. l'initiateur est ENCORE owner/admin du workspace du state (le rôle a
 *      pu changer entre le départ et le retour) ;
 *   5. quota `socialAccounts` re-vérifié pour un compte NOUVEAU (une
 *      reconnexion du même compte met à jour la ligne, jamais bloquée).
 *
 * Aucun token ne quitte ce module autrement que vers Vault. Le résultat est
 * un simple code de redirection — jamais de donnée sensible dans l'URL.
 */

export type CallbackResult = {
  /** Slug de retour ; null si inconnu (state invalide). */
  slug: string | null;
  /** `connected` ou un code d'erreur court (jamais de token ni de détail brut). */
  outcome:
    | "connected"
    | "invalid_state"
    | "not_authorized"
    | "provider_denied"
    | "quota_exceeded"
    | "exchange_failed";
};

export type CallbackDeps = {
  provider: SocialProvider;
  /** Client lié aux cookies du navigateur (session de l'initiateur). */
  userClient: SupabaseClient;
  /** Client service_role (écritures + Vault). */
  serviceClient: SupabaseClient;
  /** redirect_uri EXACT utilisé à l'aller (construit serveur). */
  redirectUri: string;
  /** Quota `socialAccounts` résolu par l'appelant (plan C7). */
  getQuota: (workspaceId: string) => Promise<number>;
};

export async function handleOAuthCallback(
  deps: CallbackDeps,
  params: URLSearchParams,
): Promise<CallbackResult> {
  const db = deps.serviceClient;

  // 1 + 2. State : consommation atomique, puis cohérence de plateforme.
  const stateParam = params.get("state") ?? "";
  const state = stateParam ? await consumeOAuthState(db, stateParam) : null;
  if (!state || state.platform !== deps.provider.platform) {
    return { slug: null, outcome: "invalid_state" };
  }
  const slug = state.redirectSlug;

  // Refus utilisateur / erreur provider : flux terminé proprement.
  if (params.get("error") || !params.get("code")) {
    return { slug, outcome: "provider_denied" };
  }

  // 3. L'appelant du callback est bien l'initiateur, avec une session valide.
  const {
    data: { user },
  } = await deps.userClient.auth.getUser();
  if (!user || user.id !== state.userId) {
    return { slug, outcome: "not_authorized" };
  }

  // 4. Toujours owner/admin du workspace visé (relu en base, sous service role
  // pour éviter tout angle mort RLS, filtré explicitement).
  const { data: membership } = await db
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", state.workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return { slug, outcome: "not_authorized" };
  }

  // Échange du code puis identité du compte — tokens en mémoire serveur only.
  let tokens, identity;
  try {
    tokens = await deps.provider.exchangeCode({
      code: params.get("code") as string,
      codeVerifier: state.codeVerifier,
      redirectUri: deps.redirectUri,
    });
    identity = await deps.provider.fetchIdentity(tokens.accessToken);
  } catch (error) {
    console.error(
      `[oauth:${deps.provider.platform}] échange: ${error instanceof Error ? error.name : "erreur"}`,
    );
    return { slug, outcome: "exchange_failed" };
  }

  // 5. Nouveau compte ou reconnexion ?
  const { data: existing } = await db
    .from("social_accounts")
    .select("id, access_token_id, refresh_token_id")
    .eq("workspace_id", state.workspaceId)
    .eq("platform", deps.provider.platform)
    .eq("provider_account_id", identity.providerAccountId)
    .maybeSingle();

  if (!existing) {
    const [quota, { count }] = await Promise.all([
      deps.getQuota(state.workspaceId),
      db
        .from("social_accounts")
        .select("*", { count: "exact", head: true })
        .eq("workspace_id", state.workspaceId),
    ]);
    if (!canConnectMore(count ?? 0, quota)) {
      return { slug, outcome: "quota_exceeded" };
    }
  }

  // Stockage Vault puis upsert. En reconnexion, les anciens secrets sont
  // supprimés après le succès (rotation sans fenêtre sans token).
  const prefix = `social/${deps.provider.platform}`;
  const accessTokenId = await vaultStore(db, tokens.accessToken, `${prefix}/access`);
  const refreshTokenId = tokens.refreshToken
    ? await vaultStore(db, tokens.refreshToken, `${prefix}/refresh`)
    : null;

  const row = {
    workspace_id: state.workspaceId,
    platform: deps.provider.platform,
    provider_account_id: identity.providerAccountId,
    display_name: identity.displayName,
    avatar_url: identity.avatarUrl,
    access_token_id: accessTokenId,
    refresh_token_id: refreshTokenId,
    token_expires_at: tokens.expiresAt,
    refresh_expires_at: tokens.refreshExpiresAt,
    scopes: tokens.scopes,
    status: "active",
    status_detail: null,
    connected_by: user.id,
    connected_at: new Date().toISOString(),
  };

  const { error: upsertError } = await db
    .from("social_accounts")
    .upsert(row, { onConflict: "workspace_id,platform,provider_account_id" });
  if (upsertError) {
    console.error(`[oauth:${deps.provider.platform}] upsert: ${upsertError.code}`);
    await vaultDelete(db, accessTokenId).catch(() => undefined);
    if (refreshTokenId) await vaultDelete(db, refreshTokenId).catch(() => undefined);
    return { slug, outcome: "exchange_failed" };
  }

  if (existing) {
    if (existing.access_token_id) await vaultDelete(db, existing.access_token_id).catch(() => undefined);
    if (existing.refresh_token_id) await vaultDelete(db, existing.refresh_token_id).catch(() => undefined);
  }

  return { slug, outcome: "connected" };
}
