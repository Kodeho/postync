import "server-only";

import type { EmailConfig } from "./config";
import {
  classifyHttpStatus,
  classifyThrown,
  type EmailFailureCode,
} from "./failure";

/**
 * Transport Scaleway Transactional Email.
 *
 * Une seule responsabilité : mettre un message sur le réseau et rendre compte
 * de ce qui s'est passé. Ni décision de réessai, ni idempotence, ni
 * journalisation métier — tout cela vit dans `send.ts`, où c'est vérifiable.
 */

/** Au-delà, on considère l'appel perdu. Scaleway répond en général en < 1 s. */
const TIMEOUT_MS = 10_000;

export type OutgoingEmail = {
  to: { email: string; name?: string | null };
  subject: string;
  text: string;
  html: string;
};

export type TransportResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; code: EmailFailureCode; status: number | null };

/**
 * Identifiant de message renvoyé par Scaleway.
 *
 * La documentation publique ne fige PAS le schéma de réponse de cet endpoint.
 * On lit donc ce qui s'y trouve sans jamais en dépendre : un envoi réussi dont
 * on ne saurait pas extraire l'identifiant reste un envoi réussi. Traiter
 * l'absence d'un champ non documenté comme un échec ferait réessayer — et
 * donc expédier deux fois — un message pourtant bien parti.
 */
function extractMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const emails = (payload as { emails?: unknown }).emails;
  const premier = Array.isArray(emails) ? emails[0] : null;
  if (!premier || typeof premier !== "object") return null;
  const row = premier as { message_id?: unknown; id?: unknown };
  const candidat = row.message_id ?? row.id;
  return typeof candidat === "string" && candidat.length > 0 ? candidat : null;
}

export async function sendViaScaleway(
  config: EmailConfig,
  message: OutgoingEmail,
): Promise<TransportResult> {
  const url = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${config.region}/emails`;

  const body: Record<string, unknown> = {
    from: { email: config.from.email, name: config.from.name },
    to: [
      message.to.name
        ? { email: message.to.email, name: message.to.name }
        : { email: message.to.email },
    ],
    subject: message.subject,
    text: message.text,
    html: message.html,
    project_id: config.projectId,
  };

  // `Reply-To` passe par les en-têtes additionnels : l'expéditeur doit rester
  // le domaine authentifié, sans quoi le message serait rejeté — mais une
  // réponse humaine n'a aucune raison d'atterrir dans une boîte technique.
  if (config.replyTo) {
    body.additional_headers = [{ key: "Reply-To", value: config.replyTo }];
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Auth-Token": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // Sans délai borné, un appel bloqué retiendrait la Server Action
      // jusqu'au plafond de la fonction — l'utilisateur resterait devant un
      // bouton figé sans savoir pourquoi.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, code: classifyThrown(error), status: null };
  }

  if (!response.ok) {
    return { ok: false, code: classifyHttpStatus(response.status), status: response.status };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Corps illisible sur une réponse 2xx : le message est parti, seul son
    // identifiant nous échappe.
    payload = null;
  }

  return { ok: true, providerMessageId: extractMessageId(payload) };
}
