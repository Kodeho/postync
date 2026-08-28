import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getEmailConfig } from "./config";
import { isRetryable, type EmailFailureCode } from "./failure";
import { sendViaScaleway, type OutgoingEmail } from "./scaleway";

/**
 * Point d'entrée UNIQUE de tout envoi de courriel par POSTYNC.
 *
 * Rien n'appelle Scaleway directement : ni les invitations, ni ce qui viendra
 * après. C'est ce qui permet de tenir en un seul endroit l'idempotence, la
 * politique de réessai et la règle de journalisation — trois choses qu'on
 * n'applique jamais deux fois de la même façon si on les écrit deux fois.
 *
 * Les courriels d'AUTHENTIFICATION (confirmation d'inscription,
 * réinitialisation) ne passent PAS par ici : ils sont émis par Supabase Auth
 * lui-même, via son SMTP. Les faire transiter par cette couche supposerait de
 * réimplémenter des flux que Supabase gère déjà, et de manipuler des jetons
 * que POSTYNC n'a aucune raison de voir.
 */

/** Deux tentatives supplémentaires : au-delà, on fait attendre pour rien. */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

export type SendOutcome =
  | { ok: true; deliveryId: string; providerMessageId: string | null }
  /** L'envoi n'est pas configuré : l'appelant doit se rabattre. */
  | { ok: false; code: "not_configured" }
  /** Un envoi pour cette même cause a déjà eu lieu. */
  | { ok: false; code: "already_sent" }
  | { ok: false; code: EmailFailureCode };

export type SendRequest = {
  /**
   * Cause de l'envoi, stable et unique — p. ex. `invitation:<id>`.
   *
   * Stable : deux exécutions de la MÊME cause doivent produire la même clé,
   * sans quoi l'idempotence ne protège de rien. Elle ne doit donc contenir ni
   * horodatage, ni valeur aléatoire.
   */
  idempotencyKey: string;
  /** Nom du modèle, pour la journalisation et le diagnostic. */
  template: string;
  to: { email: string; name?: string | null };
  subject: string;
  text: string;
  html: string;
  workspaceId?: string | null;
};

export type SendDeps = {
  /** Client service_role : cette table n'est accessible à personne d'autre. */
  db: SupabaseClient;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable pour les tests ; par défaut, le vrai transport. */
  transport?: typeof sendViaScaleway;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Journalise SANS jamais divulguer le contenu.
 *
 * Ne sortent d'ici que l'identifiant de la ligne, le modèle et un code. Ni
 * l'adresse du destinataire, ni le sujet, ni — surtout — le lien : une
 * invitation porte un jeton, et POSTYNC a pris soin de n'en stocker que
 * l'empreinte. L'écrire dans un journal annulerait ce soin d'un trait. Le
 * détail nécessaire au diagnostic vit dans `email_deliveries`, protégée.
 */
function journaliser(deliveryId: string, template: string, issue: string): void {
  console.error(`[email:${template}] ${issue} delivery=${deliveryId}`);
}

export async function sendTransactionalEmail(
  deps: SendDeps,
  request: SendRequest,
): Promise<SendOutcome> {
  const config = getEmailConfig();
  if (!config) {
    // Ni erreur ni exception : c'est l'état normal tant que le domaine n'est
    // pas authentifié. L'appelant décide — pour une invitation, afficher le
    // lien plutôt que de laisser croire qu'un message est parti.
    return { ok: false, code: "not_configured" };
  }

  const { db } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const transport = deps.transport ?? sendViaScaleway;
  const recipient = request.to.email.trim().toLowerCase();

  // INSERTION AVANT ENVOI. L'index unique tranche : si la ligne existe déjà,
  // un envoi pour cette même cause a eu lieu — ou est en cours dans une autre
  // requête — et l'on ne renvoie rien. Vérifier puis insérer laisserait la
  // fenêtre habituelle entre les deux.
  const { data: delivery, error: insertion } = await db
    .from("email_deliveries")
    .insert({
      idempotency_key: request.idempotencyKey,
      template: request.template,
      recipient,
      workspace_id: request.workspaceId ?? null,
      status: "sending",
    })
    .select("id")
    .single<{ id: string }>();

  if (insertion) {
    if (insertion.code === "23505") {
      return { ok: false, code: "already_sent" };
    }
    console.error(`[email:${request.template}] journal indisponible ${insertion.code ?? "inconnu"}`);
    return { ok: false, code: "unknown" };
  }

  const message: OutgoingEmail = {
    to: { email: recipient, name: request.to.name ?? null },
    subject: request.subject,
    text: request.text,
    html: request.html,
  };

  let dernier: EmailFailureCode = "unknown";

  for (let tentative = 1; tentative <= MAX_ATTEMPTS; tentative += 1) {
    const resultat = await transport(config, message);

    if (resultat.ok) {
      await db
        .from("email_deliveries")
        .update({
          status: "sent",
          provider_message_id: resultat.providerMessageId,
          attempts: tentative,
        })
        .eq("id", delivery.id);
      return {
        ok: true,
        deliveryId: delivery.id,
        providerMessageId: resultat.providerMessageId,
      };
    }

    dernier = resultat.code;

    // On ne réessaie QUE ce qui ne dépend pas de ce qu'on a envoyé. Une clé
    // invalide ou une adresse refusée ne se répare pas en insistant.
    if (!isRetryable(resultat.code) || tentative === MAX_ATTEMPTS) {
      break;
    }
    await sleep(BASE_BACKOFF_MS * 2 ** (tentative - 1));
  }

  await db
    .from("email_deliveries")
    .update({ status: "failed", failure_code: dernier, attempts: MAX_ATTEMPTS })
    .eq("id", delivery.id);

  journaliser(delivery.id, request.template, dernier);
  return { ok: false, code: dernier };
}
