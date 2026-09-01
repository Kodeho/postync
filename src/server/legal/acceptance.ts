import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { PRIVACY_VERSION, TERMS_VERSION } from "@/config/legal";
import { createServiceClient } from "@/server/supabase/service-client";

/**
 * Acceptation des documents légaux : enregistrement et vérification.
 *
 * DEUX CLIENTS, DEUX RÔLES, et la distinction n'est pas cosmétique :
 *
 *   - l'ÉCRITURE passe par `service_role`. Aucun droit d'insertion n'est
 *     accordé à `authenticated` : c'est ce qui rend impossible de forger une
 *     acceptation, pour soi comme pour un autre. Les versions enregistrées
 *     sont celles du serveur, jamais celles qu'un formulaire prétendrait.
 *   - la LECTURE passe par le client de l'utilisateur, sous RLS. La garde lit
 *     donc ce que la base l'autorise à voir, et rien de plus.
 *
 * AUCUN RÔLE APPLICATIF NE PEUT EFFACER NI RÉÉCRIRE UNE ACCEPTATION.
 * `service_role` n'a que `SELECT` et `INSERT` ; `UPDATE` et `DELETE` ne sont
 * accordés à personne. Ce module ne comporte donc volontairement aucune
 * fonction de suppression : la seule disparition légitime est la cascade sur
 * suppression du compte, exécutée par le moteur et non par un appel d'ici.
 */

/** Le couple de versions actuellement en vigueur. Source : `config/legal`. */
export const CURRENT_LEGAL_VERSIONS = {
  terms: TERMS_VERSION,
  privacy: PRIVACY_VERSION,
} as const;

/**
 * Enregistre l'acceptation des versions COURANTES pour un utilisateur.
 *
 * Idempotent : la contrainte unique `(user_id, terms_version, privacy_version)`
 * absorbe une seconde acceptation de la même paire. Deux soumissions, un
 * double-clic ou une reprise après erreur ne créent donc pas de doublon — et
 * la première date est conservée, qui est la bonne.
 *
 * `accepted_at` n'est jamais transmis : la valeur par défaut de la colonne
 * l'écrit côté serveur.
 */
export async function recordLegalAcceptance(
  userId: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!userId) {
    return { ok: false, code: "user_missing" };
  }

  const db = createServiceClient();
  const { error } = await db.from("legal_acceptances").upsert(
    {
      user_id: userId,
      terms_version: CURRENT_LEGAL_VERSIONS.terms,
      privacy_version: CURRENT_LEGAL_VERSIONS.privacy,
    },
    { onConflict: "user_id,terms_version,privacy_version", ignoreDuplicates: true },
  );

  if (error) {
    // Code court, jamais le message : il pourrait citer une valeur de ligne.
    console.error(`[legal:accept] ${error.code ?? "inconnu"}`);
    return { ok: false, code: "storage_failed" };
  }
  return { ok: true };
}

/**
 * L'utilisateur a-t-il accepté les versions courantes ?
 *
 * ON NE DÉDUIT AUCUNE ACCEPTATION RÉTROACTIVE. Un compte créé avant la mise en
 * place de ce registre n'a pas de ligne : il doit réaccepter. C'est le seul
 * comportement honnête — présumer l'accord de quelqu'un dont on n'a pas la
 * trace, c'est fabriquer la preuve qu'on cherche à produire.
 *
 * Une erreur de lecture rend `false` : mieux vaut redemander une acceptation
 * déjà donnée que laisser passer sur une panne.
 */
export async function hasAcceptedCurrentLegalVersions(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  if (!userId) return false;

  const { data, error } = await supabase
    .from("legal_acceptances")
    .select("id")
    .eq("user_id", userId)
    .eq("terms_version", CURRENT_LEGAL_VERSIONS.terms)
    .eq("privacy_version", CURRENT_LEGAL_VERSIONS.privacy)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[legal:check] ${error.code ?? "inconnu"}`);
    return false;
  }
  return data !== null;
}
