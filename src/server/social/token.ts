import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SocialProvider, TokenSet } from "./providers/types";
import { vaultDelete, vaultRead, vaultStore } from "./vault";

/**
 * Obtention d'un access token UTILISABLE, avec rafraîchissement à la demande.
 *
 * Jusqu'ici `provider.refresh()` était déclaré mais jamais appelé : un jeton
 * YouTube mourait au bout d'une heure et rien ne le renouvelait. C'est ce
 * module qui comble le vide, et il est le SEUL endroit où un jeton social est
 * lu, renouvelé ou invalidé.
 *
 * Règles :
 *   * on rafraîchit AVANT expiration, avec une marge — un jeton qui expire
 *     pendant une publication de 45 secondes serait pire qu'un jeton expiré ;
 *   * la rotation est intégrale : TikTok renvoie un NOUVEAU refresh token, et
 *     l'ancien secret n'est détruit qu'APRÈS l'écriture réussie ;
 *   * un refus de la plateforme n'est jamais silencieux : le compte bascule
 *     dans un statut qui exige une reconnexion, et l'interface le montre ;
 *   * aucun jeton n'est journalisé, ni renvoyé au navigateur.
 */

/** Marge avant expiration : on renouvelle plutôt que de courir le risque. */
export const REFRESH_MARGIN_MS = 2 * 60_000;

export type UsableTokenResult =
  | { ok: true; accessToken: string; refreshed: boolean }
  | { ok: false; code: "token_unavailable" | "needs_reconnect" };

export type TokenAccount = {
  id: string;
  platform: string;
  access_token_id: string | null;
  refresh_token_id: string | null;
  token_expires_at: string | null;
};

export type TokenDeps = {
  /** Client service_role : Vault et écritures. */
  db: SupabaseClient;
  now?: () => number;
};

/** Un refus définitif de la plateforme, distingué d'une panne passagère. */
function isRevocation(message: string): boolean {
  // `invalid_grant` est la réponse OAuth standard quand l'autorisation a été
  // retirée ou que le jeton n'est plus reconnu.
  return /invalid_grant|invalid_token|revoked|190/i.test(message);
}

async function markNeedsReconnect(
  db: SupabaseClient,
  accountId: string,
  status: "revoked" | "error",
  detail: string,
): Promise<void> {
  await db
    .from("social_accounts")
    .update({ status, status_detail: detail.slice(0, 120) })
    .eq("id", accountId);
}

/**
 * Écrit un jeu de jetons renouvelé : nouveaux secrets d'abord, mise à jour de
 * la ligne, puis destruction des anciens. Jamais l'inverse — une coupure au
 * mauvais moment laisserait le compte sans jeton utilisable.
 */
async function persistRefreshedTokens(
  db: SupabaseClient,
  account: TokenAccount,
  tokens: TokenSet,
): Promise<void> {
  const prefix = `social/${account.platform}`;
  const accessTokenId = await vaultStore(db, tokens.accessToken, `${prefix}/access`);
  // Rotation : si la plateforme renvoie un nouveau refresh token, il remplace
  // l'ancien ; si elle n'en renvoie pas, l'ancien reste valide.
  const refreshTokenId = tokens.refreshToken
    ? await vaultStore(db, tokens.refreshToken, `${prefix}/refresh`)
    : account.refresh_token_id;

  const { error } = await db
    .from("social_accounts")
    .update({
      access_token_id: accessTokenId,
      refresh_token_id: refreshTokenId,
      token_expires_at: tokens.expiresAt,
      refresh_expires_at: tokens.refreshExpiresAt,
      status: "active",
      status_detail: null,
    })
    .eq("id", account.id);

  if (error) {
    // L'écriture a échoué : on ne laisse pas de secrets orphelins dans Vault.
    await vaultDelete(db, accessTokenId).catch(() => undefined);
    if (tokens.refreshToken && refreshTokenId) {
      await vaultDelete(db, refreshTokenId).catch(() => undefined);
    }
    throw new Error(`refresh persist: ${error.code}`);
  }

  // Succès : les anciens secrets peuvent partir.
  if (account.access_token_id) {
    await vaultDelete(db, account.access_token_id).catch(() => undefined);
  }
  if (tokens.refreshToken && account.refresh_token_id) {
    await vaultDelete(db, account.refresh_token_id).catch(() => undefined);
  }
}

/**
 * Renvoie un access token exploitable pour ce compte, en le renouvelant si
 * nécessaire. L'appelant a déjà vérifié que le compte appartient bien au
 * workspace concerné.
 */
export async function getUsableAccessToken(
  deps: TokenDeps,
  provider: SocialProvider,
  account: TokenAccount,
): Promise<UsableTokenResult> {
  const now = deps.now ?? Date.now;

  if (!account.access_token_id) {
    return { ok: false, code: "token_unavailable" };
  }
  const accessToken = await vaultRead(deps.db, account.access_token_id);
  if (!accessToken) {
    return { ok: false, code: "token_unavailable" };
  }

  const expiresAt = account.token_expires_at
    ? new Date(account.token_expires_at).getTime()
    : null;
  // Pas de date d'expiration (jeton de Page Meta) ou encore loin de l'échéance :
  // le jeton part tel quel.
  if (expiresAt === null || expiresAt - now() > REFRESH_MARGIN_MS) {
    return { ok: true, accessToken, refreshed: false };
  }

  if (!provider.refresh) {
    // Rien à tenter : la plateforme n'offre pas de renouvellement.
    return { ok: false, code: "needs_reconnect" };
  }

  // Quel secret présenter ? Instagram rafraîchit son jeton AVEC LUI-MÊME ;
  // les autres exigent un refresh token distinct.
  let refreshInput: string | null;
  if (provider.refreshUsesAccessToken) {
    refreshInput = accessToken;
  } else if (account.refresh_token_id) {
    refreshInput = await vaultRead(deps.db, account.refresh_token_id);
  } else {
    refreshInput = null;
  }
  if (!refreshInput) {
    return { ok: false, code: "needs_reconnect" };
  }

  let tokens: TokenSet;
  try {
    tokens = await provider.refresh(refreshInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : "erreur";
    const revoked = isRevocation(message);
    // Le message ne contient que nos propres libellés et des codes courts —
    // jamais un jeton ni une réponse brute de la plateforme.
    console.error(`[social:token] ${account.platform} refresh: ${message}`);
    await markNeedsReconnect(
      deps.db,
      account.id,
      revoked ? "revoked" : "error",
      revoked ? "refresh_revoked" : "refresh_failed",
    );
    return { ok: false, code: "needs_reconnect" };
  }

  try {
    await persistRefreshedTokens(deps.db, account, tokens);
  } catch (error) {
    console.error(
      `[social:token] ${account.platform} persist: ${error instanceof Error ? error.message : "erreur"}`,
    );
    // Le jeton fraîchement obtenu reste utilisable pour CETTE requête, même
    // si on n'a pas pu l'enregistrer.
    return { ok: true, accessToken: tokens.accessToken, refreshed: true };
  }

  return { ok: true, accessToken: tokens.accessToken, refreshed: true };
}
