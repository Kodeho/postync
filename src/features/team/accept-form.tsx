"use client";

import { useActionState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { WORKSPACE_ROLE_LABELS } from "@/features/workspaces/display";
import type { WorkspaceRole } from "@/types/workspace-role";

import { acceptInvitationAction } from "./accept-action";
import { IDLE_TEAM_ACTION } from "./state";

/**
 * Acceptation d'une invitation (C14).
 *
 * L'acceptation demande un GESTE : un simple chargement de page — aperçu de
 * lien dans une messagerie, préchargement du navigateur — ne doit pas faire
 * rejoindre un workspace.
 */
export function AcceptInvitationForm({
  token,
  workspaceName,
  role,
  email,
}: {
  token: string;
  workspaceName: string;
  role: string;
  email: string;
}) {
  const [state, action] = useActionState(acceptInvitationAction, IDLE_TEAM_ACTION);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

      <p className="text-sm text-foreground">
        Vous êtes invité à rejoindre <span className="font-semibold">{workspaceName}</span> en tant
        que{" "}
        <span className="font-semibold">
          {WORKSPACE_ROLE_LABELS[role as WorkspaceRole] ?? role}
        </span>
        .
      </p>
      <p className="text-xs text-muted">
        Invitation adressée à {email}, et acceptée avec ce compte.
      </p>

      <SubmitButton label="Rejoindre le workspace" pendingLabel="Accès en cours…" />

      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
    </form>
  );
}
