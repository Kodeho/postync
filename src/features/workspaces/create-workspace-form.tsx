"use client";

import { useActionState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { TextField } from "@/components/ui/text-field";

import { createWorkspaceAction } from "./actions";
import { EMPTY_WORKSPACE_FORM_STATE } from "./state";
import { WORKSPACE_NAME_MAX_LENGTH } from "./validation";

type CreateWorkspaceFormProps = {
  submitLabel: string;
  pendingLabel: string;
};

/** Formulaire minimal : un nom, un bouton. Le slug est calculé côté base. */
export function CreateWorkspaceForm({
  submitLabel,
  pendingLabel,
}: CreateWorkspaceFormProps) {
  const [state, formAction] = useActionState(
    createWorkspaceAction,
    EMPTY_WORKSPACE_FORM_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}

      <TextField
        label="Nom du workspace"
        name="name"
        autoComplete="organization"
        maxLength={WORKSPACE_NAME_MAX_LENGTH}
        defaultValue={state.name}
      />

      <SubmitButton label={submitLabel} pendingLabel={pendingLabel} />
    </form>
  );
}
