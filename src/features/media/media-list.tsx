"use client";

import { useActionState } from "react";

import { Badge } from "@/components/admin/badges";
import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { deleteMediaAction, IDLE_MEDIA_ACTION } from "@/server/media/actions";
import type { PlatformCompatibility } from "@/server/media/rules";

/**
 * Suppression d'un média. La confirmation est explicite : supprimer l'objet
 * du bucket est la SEULE façon de couper réellement l'accès à un fichier —
 * l'expiration d'une URL signée ne suffit pas.
 */
export function DeleteMediaButton({
  workspaceSlug,
  assetId,
  filename,
}: {
  workspaceSlug: string;
  assetId: string;
  filename: string;
}) {
  const [state, action] = useActionState(deleteMediaAction, IDLE_MEDIA_ACTION);

  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <input type="hidden" name="assetId" value={assetId} />
      <SubmitButton label="Supprimer" pendingLabel="Suppression…" />
      <span className="sr-only">{filename}</span>
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
    </form>
  );
}

/**
 * Compatibilité d'un média avec chaque réseau, et la RAISON quand ça ne
 * passe pas. Expliquer avant vaut mieux qu'échouer après : une vidéo 16:9
 * part sur Instagram et sera refusée par Facebook.
 */
export function CompatibilityList({ report }: { report: PlatformCompatibility[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {report.map((entry) => (
        <li key={entry.platform} className="flex items-start gap-2 text-xs">
          <Badge tone={entry.compatible ? "success" : "warning"}>
            {entry.compatible ? "Compatible" : "Non compatible"}
          </Badge>
          <span className="min-w-0 flex-1">
            <span className="font-medium text-foreground">{entry.label}</span>
            {entry.reasons.length > 0 ? (
              <span className="block text-muted">{entry.reasons.join(" ")}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
