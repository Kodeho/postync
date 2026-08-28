"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/features/workspaces/queries";
import { hashInvitationToken } from "@/server/team/invitations";

import type { TeamActionState } from "./state";

/**
 * Acceptation d'une invitation (C14).
 *
 * L'appel se fait avec le client de la SESSION, pas en service_role. C'est
 * délibéré et c'est le cœur de la sécurité de cette étape :
 * `accept_workspace_invitation` lit `auth.uid()` en base et compare l'adresse
 * du compte connecté à celle de l'invitation. Passer un identifiant en
 * paramètre aurait permis à un bug applicatif de rattacher la mauvaise
 * personne ; ici, c'est structurellement impossible.
 *
 * Le jeton n'est pas transmis en clair à la base : seule son empreinte l'est.
 */

const MESSAGES: Record<string, string> = {
  not_authenticated: "Connectez-vous pour accepter cette invitation.",
  not_found: "Ce lien d'invitation n'est pas valide.",
  revoked: "Cette invitation a été annulée.",
  already_accepted: "Cette invitation a déjà été utilisée.",
  expired: "Cette invitation a expiré. Demandez-en une nouvelle.",
  email_mismatch:
    "Cette invitation a été adressée à une autre adresse e-mail. Connectez-vous avec le compte concerné.",
  workspace_gone: "Ce workspace n'existe plus.",
};

export async function acceptInvitationAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const token = String(formData.get("token") ?? "");
  if (token.length === 0) {
    return { error: MESSAGES.not_found, notice: null, invitationUrl: null, invitationId: null };
  }

  // `requireUser` applique les mêmes contrôles que partout : session valide et
  // compte non suspendu.
  await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("accept_workspace_invitation", {
    p_token_hash: hashInvitationToken(token),
  });

  if (error) {
    console.error(`[team:accept] ${error.code ?? "inconnu"}`);
    return {
      error: "L'invitation n'a pas pu être acceptée. Réessayez.",
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }

  const resultat = (data ?? [])[0] as { status: string; slug: string | null } | undefined;
  if (!resultat || resultat.status !== "accepted" || !resultat.slug) {
    return {
      error: MESSAGES[resultat?.status ?? "not_found"] ?? MESSAGES.not_found,
      notice: null,
      invitationUrl: null,
      invitationId: null,
    };
  }

  // Redirection : la personne arrive directement dans le workspace rejoint.
  redirect(`/app/${resultat.slug}`);
}
