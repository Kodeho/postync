import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SocialPlatform } from "@/types/platform";

import { deleteConnectionDraft, readConnectionDraft } from "./connection-draft";
import type { SocialProvider } from "./providers/types";
import { vaultDelete, vaultStore } from "./vault";

/**
 * Sélection des actifs d'une connexion en attente (Pages Facebook).
 *
 * Règle centrale : le jeton d'une Page ne quitte JAMAIS le serveur. La page
 * de sélection ne reçoit qu'un identifiant, un nom, un avatar et deux
 * booléens. L'appelant a déjà vérifié la session et le rôle owner/admin ; ici
 * on revérifie que le brouillon appartient bien à CE workspace et à CET
 * utilisateur, puis on applique le quota du plan.
 */

export type SelectableAsset = {
  assetId: string;
  name: string;
  avatarUrl: string | null;
  /** L'utilisateur a-t-il la tâche de publication sur cet actif ? */
  canPublish: boolean;
  /** Déjà connecté à ce workspace : la reconnexion met la ligne à jour. */
  alreadyConnected: boolean;
};

export type AssetsDeps = {
  /** Client service_role : lecture Vault et écritures. */
  db: SupabaseClient;
  getProvider: (platform: string) => SocialProvider | null;
  /** Quota `socialAccounts` du plan du workspace. */
  getQuota: (workspaceId: string) => Promise<number>;
};

export type ListAssetsResult =
  | { ok: true; platform: SocialPlatform; assets: SelectableAsset[] }
  | { ok: false; code: AssetsFailureCode };

export type ConnectAssetsResult =
  | { ok: true; connected: number; slug: string }
  | { ok: false; code: AssetsFailureCode };

export type AssetsFailureCode =
  | "draft_not_found"
  | "provider_unavailable"
  | "listing_failed"
  | "nothing_selected"
  | "not_publishable"
  | "quota_exceeded"
  | "connect_failed";

type DraftInput = { draftId: string; workspaceId: string; userId: string };

/** Liste les actifs disponibles pour un brouillon, sans aucun jeton. */
export async function listSelectableAssets(
  deps: AssetsDeps,
  input: DraftInput,
): Promise<ListAssetsResult> {
  const draft = await readConnectionDraft(deps.db, input);
  if (!draft) {
    return { ok: false, code: "draft_not_found" };
  }

  const provider = deps.getProvider(draft.platform);
  if (!provider?.assets) {
    return { ok: false, code: "provider_unavailable" };
  }

  let assets;
  try {
    assets = await provider.assets.listAssets(draft.userAccessToken);
  } catch (error) {
    console.error(
      `[social:assets] ${draft.platform}: ${error instanceof Error ? error.message : "erreur"}`,
    );
    return { ok: false, code: "listing_failed" };
  }

  const { data: existing } = await deps.db
    .from("social_accounts")
    .select("provider_account_id")
    .eq("workspace_id", draft.workspaceId)
    .eq("platform", draft.platform);
  const connected = new Set((existing ?? []).map((row) => row.provider_account_id as string));

  return {
    ok: true,
    platform: draft.platform,
    // Le jeton de chaque actif est écarté ici : il ne remonte pas d'un cran.
    assets: assets.map((asset) => ({
      assetId: asset.assetId,
      name: asset.name,
      avatarUrl: asset.avatarUrl,
      canPublish: asset.canPublish,
      alreadyConnected: connected.has(asset.assetId),
    })),
  };
}

/**
 * Connecte les actifs choisis : une ligne `social_accounts` par actif, avec
 * SON jeton dans Vault. Le brouillon — et donc le jeton utilisateur — est
 * détruit à la fin, qu'il reste ou non des actifs non retenus.
 */
export async function connectSelectedAssets(
  deps: AssetsDeps,
  input: DraftInput & { assetIds: string[] },
): Promise<ConnectAssetsResult> {
  if (input.assetIds.length === 0) {
    return { ok: false, code: "nothing_selected" };
  }

  const draft = await readConnectionDraft(deps.db, input);
  if (!draft) {
    return { ok: false, code: "draft_not_found" };
  }

  const provider = deps.getProvider(draft.platform);
  if (!provider?.assets) {
    return { ok: false, code: "provider_unavailable" };
  }

  let assets;
  try {
    assets = await provider.assets.listAssets(draft.userAccessToken);
  } catch (error) {
    console.error(
      `[social:assets] ${draft.platform}: ${error instanceof Error ? error.message : "erreur"}`,
    );
    return { ok: false, code: "listing_failed" };
  }

  // On ne fait jamais confiance aux identifiants venus du navigateur : seuls
  // les actifs réellement rattachés à CE brouillon sont retenus.
  const requested = new Set(input.assetIds);
  const selected = assets.filter((asset) => requested.has(asset.assetId));
  if (selected.length === 0) {
    return { ok: false, code: "draft_not_found" };
  }
  // Une Page sur laquelle l'utilisateur ne peut pas publier n'a pas à être
  // connectée : elle ne servirait à rien et donnerait une fausse promesse.
  if (selected.some((asset) => !asset.canPublish)) {
    return { ok: false, code: "not_publishable" };
  }

  // Quota du plan : seuls les comptes NOUVEAUX comptent, une reconnexion met
  // à jour une ligne existante.
  const { data: existingRows } = await deps.db
    .from("social_accounts")
    .select("provider_account_id, access_token_id, refresh_token_id")
    .eq("workspace_id", draft.workspaceId)
    .eq("platform", draft.platform);
  const existingById = new Map(
    (existingRows ?? []).map((row) => [row.provider_account_id as string, row]),
  );

  const { count: totalAccounts } = await deps.db
    .from("social_accounts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", draft.workspaceId);
  const quota = await deps.getQuota(draft.workspaceId);

  // Seuls les comptes NOUVEAUX augmentent le total : une reconnexion ne
  // consomme rien de plus.
  const newCount = selected.filter((asset) => !existingById.has(asset.assetId)).length;
  const totalAfter = (totalAccounts ?? 0) + newCount;
  if (totalAfter > quota) {
    return { ok: false, code: "quota_exceeded" };
  }

  const now = new Date().toISOString();
  let connectedCount = 0;

  for (const asset of selected) {
    const previous = existingById.get(asset.assetId);
    const accessTokenId = await vaultStore(
      deps.db,
      asset.token,
      `social/${draft.platform}/page`,
    );

    const { error } = await deps.db.from("social_accounts").upsert(
      {
        workspace_id: draft.workspaceId,
        platform: draft.platform,
        provider_account_id: asset.assetId,
        display_name: asset.name,
        avatar_url: asset.avatarUrl,
        access_token_id: accessTokenId,
        // Un jeton de Page n'a PAS de date d'expiration — mais il reste
        // invalidable : l'absence de date ne vaut pas éternité.
        refresh_token_id: null,
        token_expires_at: null,
        refresh_expires_at: null,
        scopes: draft.scopes,
        status: "active",
        status_detail: null,
        connected_by: draft.userId,
        connected_at: now,
      },
      { onConflict: "workspace_id,platform,provider_account_id" },
    );

    if (error) {
      console.error(`[social:assets] upsert ${draft.platform}: ${error.code}`);
      await vaultDelete(deps.db, accessTokenId).catch(() => undefined);
      continue;
    }

    // Reconnexion : l'ancien secret ne part qu'APRÈS le succès, pour ne
    // jamais laisser la ligne sans jeton utilisable.
    if (previous?.access_token_id) {
      await vaultDelete(deps.db, previous.access_token_id as string).catch(() => undefined);
    }
    if (previous?.refresh_token_id) {
      await vaultDelete(deps.db, previous.refresh_token_id as string).catch(() => undefined);
    }
    connectedCount += 1;
  }

  // Le jeton utilisateur a fini son office : il meurt avec le brouillon.
  await deleteConnectionDraft(deps.db, draft.id);

  if (connectedCount === 0) {
    return { ok: false, code: "connect_failed" };
  }
  return { ok: true, connected: connectedCount, slug: draft.redirectSlug };
}
