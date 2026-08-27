import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SocialPlatform } from "@/types/platform";

import { vaultDelete, vaultRead, vaultStore } from "./vault";

/**
 * Connexion en attente de sélection d'actif (table
 * `social_connection_drafts`, purement serveur).
 *
 * Nécessaire pour les providers dont UNE autorisation donne accès à
 * PLUSIEURS comptes publiables — Facebook et ses Pages. Entre le callback et
 * le choix de l'utilisateur, il faut conserver le jeton utilisateur le temps
 * d'énumérer les actifs, sans jamais le faire transiter par le navigateur.
 *
 * Le jeton vit dans Vault ; le brouillon ne porte qu'une référence. Il est
 * détruit dès la sélection — et le trigger purge le secret. Un abandon se
 * résout tout seul : TTL court et nettoyage opportuniste.
 */

export const DRAFT_TTL_MINUTES = 15;

export type ConnectionDraft = {
  id: string;
  workspaceId: string;
  userId: string;
  platform: SocialPlatform;
  redirectSlug: string;
  scopes: string[];
  /** Jeton utilisateur relu depuis Vault, en mémoire serveur uniquement. */
  userAccessToken: string;
};

export async function createConnectionDraft(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    userId: string;
    platform: SocialPlatform;
    redirectSlug: string;
    userAccessToken: string;
    scopes: string[];
  },
): Promise<string> {
  // Nettoyage opportuniste des brouillons périmés : pas de cron nécessaire.
  // La suppression déclenche la purge Vault, les jetons abandonnés meurent
  // donc avec eux.
  await db.from("social_connection_drafts").delete().lt("expires_at", new Date().toISOString());

  const userTokenId = await vaultStore(
    db,
    input.userAccessToken,
    `social/${input.platform}/user`,
  );

  const expiresAt = new Date(Date.now() + DRAFT_TTL_MINUTES * 60_000).toISOString();
  const { data, error } = await db
    .from("social_connection_drafts")
    .insert({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      platform: input.platform,
      redirect_slug: input.redirectSlug,
      user_token_id: userTokenId,
      scopes: input.scopes,
      expires_at: expiresAt,
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !data) {
    // Ne pas laisser un secret orphelin dans Vault si l'insertion échoue.
    await vaultDelete(db, userTokenId).catch(() => undefined);
    throw new Error(`draft insert: ${error?.code ?? "aucun id"}`);
  }
  return data.id;
}

/**
 * Relit un brouillon NON expiré appartenant bien à cet utilisateur ET à ce
 * workspace. Le filtre porte sur les trois colonnes : un identifiant de
 * brouillon volé ne suffit pas.
 */
export async function readConnectionDraft(
  db: SupabaseClient,
  input: { draftId: string; workspaceId: string; userId: string },
): Promise<ConnectionDraft | null> {
  const { data } = await db
    .from("social_connection_drafts")
    .select("id, workspace_id, user_id, platform, redirect_slug, scopes, user_token_id, expires_at")
    .eq("id", input.draftId)
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .maybeSingle<{
      id: string;
      workspace_id: string;
      user_id: string;
      platform: string;
      redirect_slug: string;
      scopes: string[] | null;
      user_token_id: string;
      expires_at: string;
    }>();

  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    // Périmé : on le supprime plutôt que de le laisser traîner avec son jeton.
    await deleteConnectionDraft(db, data.id);
    return null;
  }

  const userAccessToken = await vaultRead(db, data.user_token_id);
  if (!userAccessToken) return null;

  return {
    id: data.id,
    workspaceId: data.workspace_id,
    userId: data.user_id,
    platform: data.platform as SocialPlatform,
    redirectSlug: data.redirect_slug,
    scopes: data.scopes ?? [],
    userAccessToken,
  };
}

/** Supprime le brouillon ; le trigger purge le jeton utilisateur de Vault. */
export async function deleteConnectionDraft(db: SupabaseClient, draftId: string): Promise<void> {
  await db.from("social_connection_drafts").delete().eq("id", draftId);
}
