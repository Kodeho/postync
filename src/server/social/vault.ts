import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Accès Vault via les wrappers SQL `social_vault_*` (migration C8.1).
 *
 * Ces RPC sont exécutables par service_role UNIQUEMENT ; le schéma `vault`
 * n'est ni exposé par PostgREST ni lisible par authenticated/anon. Les
 * valeurs retournées ne doivent JAMAIS être journalisées, renvoyées au
 * navigateur, mises dans une URL ni dans l'audit.
 */

export async function vaultStore(
  db: SupabaseClient,
  secret: string,
  name: string,
): Promise<string> {
  const { data, error } = await db.rpc("social_vault_store", {
    p_secret: secret,
    p_name: name,
  });
  if (error || !data) {
    throw new Error(`vault store: ${error?.code ?? "aucun id"}`);
  }
  return data as string;
}

export async function vaultRead(db: SupabaseClient, id: string): Promise<string | null> {
  const { data, error } = await db.rpc("social_vault_read", { p_id: id });
  if (error) {
    throw new Error(`vault read: ${error.code}`);
  }
  return (data as string | null) ?? null;
}

export async function vaultDelete(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.rpc("social_vault_delete", { p_id: id });
  if (error) {
    throw new Error(`vault delete: ${error.code}`);
  }
}
