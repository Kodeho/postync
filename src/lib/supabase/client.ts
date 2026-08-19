import { createBrowserClient } from "@supabase/ssr";

import { requireSupabaseEnv } from "./env";

/**
 * Client Supabase pour le NAVIGATEUR.
 *
 * N'utilise que la clé anon publique. La clé `service_role` ne doit jamais
 * transiter par ce fichier ni par aucun module importé côté client.
 *
 * À appeler à l'intérieur d'un composant client ou d'un gestionnaire
 * d'évènement, jamais au niveau module, afin que l'absence de configuration
 * ne casse pas le rendu.
 */
export function createClient() {
  const { url, anonKey } = requireSupabaseEnv();

  return createBrowserClient(url, anonKey);
}
