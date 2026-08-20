import "server-only";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Client Supabase SERVICE ROLE — strictement serveur.
 *
 * Cette clé CONTOURNE RLS. Règles d'usage (docs/SECURITY.md) :
 *   1. `import "server-only"` : tout import depuis un composant client casse
 *      le build ;
 *   2. jamais dans un module atteignable par le navigateur ;
 *   3. réservée aux écritures de facturation (webhook Stripe, Server Actions
 *      de checkout) — TOUJOURS après vérification de l'autorisation
 *      applicative (session + rôle) ou de la signature Stripe ;
 *   4. la clé n'est jamais journalisée ni renvoyée.
 */
export function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY ou NEXT_PUBLIC_SUPABASE_URL manquante côté serveur.",
    );
  }
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
