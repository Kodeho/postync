/** État du formulaire de création de workspace (Server Action ↔ client). */
export type WorkspaceFormState = {
  error: string | null;
  /** Nom saisi, renvoyé après une erreur pour éviter la ressaisie. */
  name?: string;
};

export const EMPTY_WORKSPACE_FORM_STATE: WorkspaceFormState = { error: null };
