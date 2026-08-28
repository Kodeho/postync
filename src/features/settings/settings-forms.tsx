"use client";

import { useActionState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { TextField } from "@/components/ui/text-field";
import { COMMON_TIME_ZONES } from "@/lib/time-zone";

import {
  renameWorkspaceAction,
  updateDisplayNameAction,
  updateTimeZoneAction,
} from "./actions";
import { IDLE_SETTINGS_FORM } from "./state";

/**
 * Formulaires de réglages (C13).
 *
 * Chacun s'enregistre séparément : un utilisateur qui corrige son nom affiché
 * n'a aucune raison de voir échouer l'opération parce qu'un autre champ, qu'il
 * n'a pas touché, poserait problème.
 */

export function RenameWorkspaceForm({
  workspaceSlug,
  currentName,
}: {
  workspaceSlug: string;
  currentName: string;
}) {
  const [state, action] = useActionState(renameWorkspaceAction, IDLE_SETTINGS_FORM);

  return (
    <form action={action} className="mt-4 flex flex-col gap-3">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <TextField
        label="Nom du workspace"
        name="name"
        defaultValue={currentName}
        required
        maxLength={80}
        hint="L'adresse du workspace ne change pas : vos liens et vos connexions restent valides."
      />
      <div className="flex items-center gap-3">
        <SubmitButton label="Enregistrer" pendingLabel="Enregistrement…" />
      </div>
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
      {state.notice ? <FormAlert tone="notice">{state.notice}</FormAlert> : null}
    </form>
  );
}

export function TimeZoneForm({
  workspaceSlug,
  currentTimeZone,
}: {
  workspaceSlug: string;
  currentTimeZone: string;
}) {
  const [state, action] = useActionState(updateTimeZoneAction, IDLE_SETTINGS_FORM);

  // Le fuseau enregistré peut ne pas figurer dans la liste courte : on
  // l'ajoute plutôt que de le faire disparaître du menu, ce qui donnerait
  // l'impression qu'un autre fuseau est sélectionné.
  const choix = (COMMON_TIME_ZONES as readonly string[]).includes(currentTimeZone)
    ? COMMON_TIME_ZONES
    : [currentTimeZone, ...COMMON_TIME_ZONES];

  return (
    <form action={action} className="mt-4 flex flex-col gap-3">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-foreground">Fuseau horaire</span>
        <select
          name="timeZone"
          defaultValue={currentTimeZone}
          className="rounded-md border border-border bg-surface px-3 py-2 text-foreground shadow-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
        >
          {choix.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted">
          Toutes les heures de POSTYNC s&apos;y réfèrent : le calendrier, la vue d&apos;ensemble, et
          l&apos;heure que vous saisissez en programmant une publication.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <SubmitButton label="Enregistrer" pendingLabel="Enregistrement…" />
      </div>
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
      {state.notice ? <FormAlert tone="notice">{state.notice}</FormAlert> : null}
    </form>
  );
}

export function DisplayNameForm({ currentName }: { currentName: string | null }) {
  const [state, action] = useActionState(updateDisplayNameAction, IDLE_SETTINGS_FORM);

  return (
    <form action={action} className="mt-4 flex flex-col gap-3">
      <TextField
        label="Nom affiché"
        name="displayName"
        defaultValue={currentName ?? ""}
        required
        maxLength={80}
        hint="Visible par les autres membres de vos workspaces."
      />
      <div className="flex items-center gap-3">
        <SubmitButton label="Enregistrer" pendingLabel="Enregistrement…" />
      </div>
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
      {state.notice ? <FormAlert tone="notice">{state.notice}</FormAlert> : null}
    </form>
  );
}
