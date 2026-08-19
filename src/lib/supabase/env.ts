/**
 * Lecture centralisée des variables d'environnement Supabase.
 *
 * Seules les variables `NEXT_PUBLIC_*` sont lues ici : elles sont inlinées au
 * build et donc exposées au navigateur, ce qui est attendu pour l'URL du projet
 * et la clé anon (protégées par RLS).
 *
 * `SUPABASE_SERVICE_ROLE_KEY` n'est volontairement JAMAIS lue dans ce module,
 * qui est importé par du code client. Voir docs/SECURITY.md.
 */

// Les accès à `process.env.NEXT_PUBLIC_*` doivent rester des expressions
// littérales complètes pour que Next.js puisse les remplacer au build.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * Indique si les variables Supabase sont renseignées.
 *
 * Permet de construire et de lancer POSTYNC sans `.env.local` : l'application
 * affiche alors un message de configuration au lieu de planter au build.
 */
export function isSupabaseConfigured(): boolean {
  return url.length > 0 && anonKey.length > 0;
}

export type SupabaseEnv = {
  url: string;
  anonKey: string;
};

/**
 * Retourne les variables Supabase ou lève une erreur explicite.
 * À n'appeler qu'au moment d'une requête, jamais au chargement d'un module.
 */
export function requireSupabaseEnv(): SupabaseEnv {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Supabase n'est pas configuré. Renseignez NEXT_PUBLIC_SUPABASE_URL et " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY dans .env.local (voir .env.example).",
    );
  }

  return { url, anonKey };
}
