import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SocialPlatform } from "@/types/platform";

import {
  codeChallengeS256,
  generateCodeVerifier,
  generateState,
  hashState,
} from "./pkce";
import { vaultDelete, vaultRead, vaultStore } from "./vault";

/**
 * Cycle de vie du `state` OAuth (table `oauth_states`, purement serveur).
 *
 * - usage unique : consommation ATOMIQUE (`update … where consumed_at is null`) ;
 *   un callback rejoué trouve un state déjà consommé et échoue ;
 * - TTL 10 minutes ;
 * - seul le hachage SHA-256 du state est stocké ;
 * - le code_verifier PKCE vit dans Vault et est détruit à la consommation.
 */

export const STATE_TTL_MINUTES = 10;

export type CreatedOAuthState = {
  /** Valeur opaque à transmettre au provider. */
  state: string;
  /** Challenge S256 à transmettre si le provider utilise PKCE. */
  codeChallenge: string | null;
};

export type ConsumedOAuthState = {
  workspaceId: string;
  userId: string;
  platform: SocialPlatform;
  redirectSlug: string;
  codeVerifier: string | null;
};

export async function createOAuthState(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    userId: string;
    platform: SocialPlatform;
    redirectSlug: string;
    usePkce: boolean;
  },
): Promise<CreatedOAuthState> {
  // Nettoyage opportuniste des states expirés (pas de cron nécessaire).
  await db.from("oauth_states").delete().lt("expires_at", new Date().toISOString());

  const state = generateState();
  let codeChallenge: string | null = null;
  let codeVerifierId: string | null = null;

  if (input.usePkce) {
    const verifier = generateCodeVerifier();
    codeChallenge = codeChallengeS256(verifier);
    codeVerifierId = await vaultStore(db, verifier, `oauth_verifier/${input.platform}`);
  }

  const { error } = await db.from("oauth_states").insert({
    state_hash: hashState(state),
    workspace_id: input.workspaceId,
    user_id: input.userId,
    platform: input.platform,
    code_verifier_id: codeVerifierId,
    redirect_slug: input.redirectSlug,
    expires_at: new Date(Date.now() + STATE_TTL_MINUTES * 60_000).toISOString(),
  });
  if (error) {
    if (codeVerifierId) {
      await vaultDelete(db, codeVerifierId).catch(() => undefined);
    }
    throw new Error(`oauth_states insert: ${error.code}`);
  }

  return { state, codeChallenge };
}

/**
 * Consomme un state : null si inconnu, expiré ou DÉJÀ consommé (replay).
 * Récupère puis détruit le code_verifier associé.
 */
export async function consumeOAuthState(
  db: SupabaseClient,
  state: string,
): Promise<ConsumedOAuthState | null> {
  const { data, error } = await db
    .from("oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state_hash", hashState(state))
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("workspace_id, user_id, platform, redirect_slug, code_verifier_id")
    .maybeSingle();

  if (error) {
    console.error(`[oauth:state] ${error.code}`);
    return null;
  }
  if (!data) {
    return null;
  }

  let codeVerifier: string | null = null;
  if (data.code_verifier_id) {
    codeVerifier = await vaultRead(db, data.code_verifier_id);
    await vaultDelete(db, data.code_verifier_id).catch(() => undefined);
  }

  return {
    workspaceId: data.workspace_id,
    userId: data.user_id,
    platform: data.platform as SocialPlatform,
    redirectSlug: data.redirect_slug,
    codeVerifier,
  };
}
