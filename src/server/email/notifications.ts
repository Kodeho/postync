import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendTransactionalEmail, type SendOutcome } from "./send";
import { buildInvitationEmail } from "./templates/invitation";
import { buildPasswordChangedEmail } from "./templates/security";

/**
 * Les courriels que POSTYNC sait envoyer.
 *
 * Chaque fonction ne fait que deux choses : composer le message et choisir sa
 * CLÉ D'IDEMPOTENCE. Le reste — configuration, réessai, journal — appartient à
 * `send.ts`, et n'est donc écrit qu'une fois.
 *
 * Ajouter un courriel au produit, c'est ajouter une fonction ici et un gabarit
 * à côté. Rien d'autre ne doit bouger.
 */

/**
 * Invitation d'équipe (C14).
 *
 * CLÉ : l'identifiant de l'invitation. Elle est parfaitement stable — un
 * renvoi révoque l'ancienne et en crée une NOUVELLE, avec un nouvel
 * identifiant, donc une nouvelle clé. Deux soumissions du même formulaire, en
 * revanche, portent le même identifiant et ne produisent qu'un seul envoi.
 */
export async function sendInvitationEmail(
  db: SupabaseClient,
  input: {
    invitationId: string;
    workspaceId: string;
    workspaceName: string;
    email: string;
    role: string;
    invitationUrl: string;
    invitedByName?: string | null;
    expiresAt: string;
  },
): Promise<SendOutcome> {
  const message = buildInvitationEmail({
    workspaceName: input.workspaceName,
    role: input.role,
    invitationUrl: input.invitationUrl,
    invitedByName: input.invitedByName ?? null,
    expiresAt: input.expiresAt,
  });

  return sendTransactionalEmail(
    { db },
    {
      idempotencyKey: `invitation:${input.invitationId}`,
      template: "invitation",
      to: { email: input.email },
      workspaceId: input.workspaceId,
      ...message,
    },
  );
}

/**
 * Notification de changement de mot de passe (C15).
 *
 * CLÉ : l'utilisateur et la MINUTE de l'événement. Contrairement à une
 * invitation, un changement de mot de passe n'a pas d'identifiant propre à
 * quoi s'accrocher. Le seau d'une minute règle le cas réel — une action
 * soumise deux fois — sans empêcher un second changement délibéré plus tard
 * dans la journée. C'est un compromis assumé, pas une idempotence parfaite.
 */
export async function sendPasswordChangedEmail(
  db: SupabaseClient,
  input: {
    userId: string;
    email: string;
    origin: "reset" | "settings";
    timeZone: string;
    occurredAt?: Date;
  },
): Promise<SendOutcome> {
  const moment = input.occurredAt ?? new Date();
  const seau = moment.toISOString().slice(0, 16); // AAAA-MM-JJTHH:MM

  const message = buildPasswordChangedEmail({
    origin: input.origin,
    occurredAtIso: moment.toISOString(),
    timeZone: input.timeZone,
  });

  return sendTransactionalEmail(
    { db },
    {
      idempotencyKey: `password-changed:${input.userId}:${seau}`,
      template: "password-changed",
      to: { email: input.email },
      ...message,
    },
  );
}
