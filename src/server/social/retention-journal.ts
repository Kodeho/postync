import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Journal des passes de rétention — écriture dans `retention_runs`.
 *
 * Extrait de la route pour être testable, et parce que ses deux règles
 * méritent d'être des invariants prouvés plutôt que des intentions :
 *
 * 1. LE JOURNAL NE CASSE JAMAIS LA PASSE. Une passe réussie dont seule la
 *    journalisation échoue reste une passe réussie : `consignerPasse` avale
 *    l'erreur RENDUE (`{ error }`) comme l'exception LEVÉE (réseau coupé,
 *    client mal construit) et ne lève jamais rien.
 *
 * 2. `error_code` NE PORTE QUE DES CODES CONTRÔLÉS. Tronquer `err.message`
 *    ne garantit rien : un message inattendu peut charrier un en-tête, une
 *    URL signée, un fragment de réponse. Ce qui part en base est choisi dans
 *    une liste fermée — la même que la contrainte CHECK de la table — et le
 *    message d'origine n'y transite jamais.
 */

/** Vocabulaire fermé de `error_code`. Doit rester égal au CHECK de la table. */
export const CODES_ERREUR = [
  "vault_error",
  "provider_error",
  "network_error",
  "db_error",
  "unknown_error",
] as const;
export type CodeErreur = (typeof CODES_ERREUR)[number];

/**
 * Classe une exception d'invocation vers le vocabulaire fermé.
 *
 * Les préfixes reconnus sont ceux que NOS modules construisent (`vault.ts`,
 * `providers/youtube.ts`) — des libellés internes, pas des réponses brutes.
 * Tout le reste, y compris un message qui contiendrait une donnée sensible,
 * devient `unknown_error` : le message n'est jamais recopié.
 */
export function codeErreurControle(err: unknown): CodeErreur {
  const message = err instanceof Error ? err.message : "";
  if (/^vault (store|read|delete):/.test(message)) return "vault_error";
  if (/^refresh persist:/.test(message)) return "db_error";
  if (/^(google (token|refresh)|youtube channels):/.test(message)) return "provider_error";
  if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(message)) return "network_error";
  return "unknown_error";
}

/**
 * Une ligne de `retention_runs`.
 *
 * Compteurs NULLABLES, et la distinction compte : `0` est une MESURE (la
 * passe a tourné et n'a rien eu à faire), `null` veut dire INCONNU — la
 * passe a échoué en vol et son rapport est perdu ; des opérations partielles
 * ont pu avoir lieu sans être comptées. La vérité par compte reste dans
 * `social_accounts`.
 */
export type LignePasse = {
  examined: number | null;
  refreshed: number | null;
  purged: number | null;
  retried: number | null;
  publications_purged: number | null;
  batches: number | null;
  saturated: boolean | null;
  duration_ms: number;
  error_code: CodeErreur | null;
};

/**
 * Insère la ligne. N'échoue JAMAIS — voir l'en-tête du module.
 *
 * Les LOGS aussi s'en tiennent aux codes contrôlés : jamais un message
 * d'erreur. Seule exception admise, le champ `code` d'une erreur PostgREST
 * (SQLSTATE ou code PGRST), et uniquement s'il a la FORME d'un code — un
 * champ inattendu qui ressemblerait à du texte libre est remplacé.
 */
export async function consignerPasse(db: SupabaseClient, ligne: LignePasse): Promise<void> {
  try {
    const { error } = await db.from("retention_runs").insert(ligne);
    if (error) {
      const codePg =
        typeof error.code === "string" && /^[0-9A-Za-z_]{1,12}$/.test(error.code)
          ? error.code
          : "sans_code";
      console.error(`[cron:retention] journal: db_error/${codePg}`);
    }
  } catch (err) {
    // Le journal ne transforme pas une passe réussie en échec, et rien du
    // message ne fuit : code contrôlé uniquement.
    console.error(`[cron:retention] journal: ${codeErreurControle(err)}`);
  }
}
