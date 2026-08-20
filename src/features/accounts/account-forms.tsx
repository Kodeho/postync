"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { disconnectAction, startConnectAction } from "@/server/social/actions";
import { IDLE_SOCIAL_ACTION } from "@/server/social/action-state";

/**
 * Formulaires client de la page comptes sociaux. Seuls un slug, une
 * plateforme et (pour déconnecter/reconnecter) un id de compte transitent —
 * tout est revérifié côté serveur.
 */

export function ConnectButton({
  workspaceSlug,
  platform,
  label,
  available,
}: {
  workspaceSlug: string;
  platform: string;
  label: string;
  available: boolean;
}) {
  const [state, action] = useActionState(startConnectAction, IDLE_SOCIAL_ACTION);

  if (!available) {
    return (
      <Button variant="secondary" size="sm" disabled title="Disponible dans une prochaine étape">
        Connecter
      </Button>
    );
  }
  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <input type="hidden" name="platform" value={platform} />
      <SubmitButton label={label} pendingLabel="Redirection…" />
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
    </form>
  );
}

export function ReconnectButton({
  workspaceSlug,
  platform,
  accountId,
}: {
  workspaceSlug: string;
  platform: string;
  accountId: string;
}) {
  const [state, action] = useActionState(startConnectAction, IDLE_SOCIAL_ACTION);

  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <input type="hidden" name="platform" value={platform} />
      <input type="hidden" name="accountId" value={accountId} />
      <SubmitButton label="Reconnecter" pendingLabel="Redirection…" />
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
    </form>
  );
}

export function DisconnectButton({
  workspaceSlug,
  accountId,
}: {
  workspaceSlug: string;
  accountId: string;
}) {
  const [state, action] = useActionState(disconnectAction, IDLE_SOCIAL_ACTION);

  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <input type="hidden" name="accountId" value={accountId} />
      <Button type="submit" variant="secondary" size="sm">
        Déconnecter
      </Button>
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
    </form>
  );
}
