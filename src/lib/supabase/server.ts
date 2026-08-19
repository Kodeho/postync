import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { requireSupabaseEnv } from "./env";

/**
 * Client Supabase pour le SERVEUR (Server Components, Server Actions,
 * Route Handlers).
 *
 * Ce module importe `next/headers` : toute tentative de l'importer depuis un
 * composant client provoque une erreur de build, ce qui garantit qu'il ne
 * fuite pas vers le navigateur.
 *
 * Il n'utilise que la clé anon : les requêtes restent donc soumises aux
 * politiques RLS de l'utilisateur connecté.
 */
export async function createClient() {
  const { url, anonKey } = requireSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Écriture de cookies impossible depuis un Server Component.
          // Le rafraîchissement de session est assuré par `src/proxy.ts`,
          // cette erreur peut donc être ignorée sans risque.
        }
      },
    },
  });
}
