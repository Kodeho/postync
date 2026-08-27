"use client";

import { useActionState, useState } from "react";

import { Avatar } from "@/components/ui/avatar";
import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { connectAssetsAction } from "@/server/social/actions";
import { IDLE_SOCIAL_ACTION } from "@/server/social/action-state";
import type { SelectableAsset } from "@/server/social/assets";

/**
 * Sélection des Pages à connecter.
 *
 * Le navigateur ne reçoit QUE des identifiants, des noms et des avatars —
 * jamais un jeton de Page. Tout est revérifié côté serveur contre le
 * brouillon de connexion.
 */
export function AssetSelectionForm({
  workspaceSlug,
  draftId,
  assets,
}: {
  workspaceSlug: string;
  draftId: string;
  assets: SelectableAsset[];
}) {
  const [state, action] = useActionState(connectAssetsAction, IDLE_SOCIAL_ACTION);
  // Les Pages déjà connectées sont pré-cochées : valider met leur jeton à jour.
  const [selected, setSelected] = useState<string[]>(
    assets.filter((asset) => asset.alreadyConnected && asset.canPublish).map((a) => a.assetId),
  );

  const toggle = (assetId: string) => {
    setSelected((current) =>
      current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId],
    );
  };

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <input type="hidden" name="draftId" value={draftId} />

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {assets.map((asset) => {
          const disabled = !asset.canPublish;
          return (
            <li key={asset.assetId}>
              <label
                className={`flex items-center gap-3 p-4 ${
                  disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  name="assetIds"
                  value={asset.assetId}
                  checked={selected.includes(asset.assetId)}
                  onChange={() => toggle(asset.assetId)}
                  disabled={disabled}
                />
                <Avatar
                  label={asset.name}
                  seed={asset.assetId}
                  src={asset.avatarUrl}
                  size="sm"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {asset.name}
                  </span>
                  <span className="block text-xs text-muted">
                    {disabled
                      ? "Vous ne pouvez pas publier sur cette Page."
                      : asset.alreadyConnected
                        ? "Déjà connectée — valider met son autorisation à jour."
                        : "Disponible"}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}

      <div className="flex items-center gap-3">
        <SubmitButton label="Connecter la sélection" pendingLabel="Connexion…" />
        <a
          href={`/app/${workspaceSlug}/accounts`}
          className="text-xs text-muted underline-offset-2 hover:underline"
        >
          Annuler
        </a>
      </div>
    </form>
  );
}
