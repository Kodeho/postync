"use client";

import { useActionState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { cancelScheduledPublicationAction } from "@/server/social/actions";
import { IDLE_SOCIAL_ACTION } from "@/server/social/action-state";

/**
 * Annulation d'une publication encore programmée.
 *
 * Le bouton n'est proposé que pour un statut `scheduled` : dès que le
 * planificateur a réclamé la ligne, la publication est peut-être déjà en route
 * chez la plateforme, et le serveur refuse alors l'annulation. Mieux vaut ne
 * pas proposer une action qui échouera que la proposer et se dédire.
 */
export function CancelScheduledButton({
  workspaceSlug,
  publicationId,
}: {
  workspaceSlug: string;
  publicationId: string;
}) {
  const [state, action] = useActionState(cancelScheduledPublicationAction, IDLE_SOCIAL_ACTION);

  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <input type="hidden" name="publicationId" value={publicationId} />
      <button
        type="submit"
        className="self-start text-[11px] text-muted underline-offset-2 hover:text-danger hover:underline"
      >
        Annuler
      </button>
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
    </form>
  );
}
