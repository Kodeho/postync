import "server-only";

import { redirect } from "next/navigation";

import type { SupabaseClient } from "@supabase/supabase-js";

import { hasAcceptedCurrentLegalVersions } from "./acceptance";

/** Écran de réacceptation. Il ne doit JAMAIS appeler cette garde. */
export const LEGAL_ACCEPT_PATH = "/legal/accept";

/**
 * Barre l'accès aux fonctionnalités de l'application tant que les versions
 * courantes ne sont pas acceptées.
 *
 * OÙ ELLE EST POSÉE. Aux trois points d'entrée des pages applicatives :
 * `/app`, `/onboarding`, et `getWorkspaceContext()` qui couvre tout
 * `/app/[workspaceSlug]/*`. Il n'existe pas d'autre chemin vers l'interface.
 *
 * OÙ ELLE N'EST PAS POSÉE, et c'est délibéré :
 *
 *   · sur les documents légaux eux-mêmes. Exiger d'accepter pour pouvoir LIRE
 *     ce qu'on accepte serait absurde — et un dark pattern manifeste ;
 *   · sur la déconnexion. Un utilisateur qui refuse doit pouvoir partir ;
 *   · sur les traitements SERVEUR déjà planifiés. Le planificateur tourne en
 *     `service_role` et ne consulte pas cette table : une publication
 *     programmée hier part comme prévu, même si son auteur doit réaccepter.
 *     Suspendre un envoi pour un motif documentaire ferait rater une échéance
 *     à un client sans le prévenir.
 */
export async function requireLegalAcceptance(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  const accepte = await hasAcceptedCurrentLegalVersions(supabase, userId);
  if (!accepte) {
    redirect(LEGAL_ACCEPT_PATH);
  }
}
