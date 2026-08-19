import type { WorkspaceRole } from "./workspace-role";

/**
 * Lignes des tables `workspaces` et `workspace_members`, telles que renvoyées
 * par Supabase (noms de colonnes en snake_case, dates ISO 8601).
 *
 * Volontairement minimal : pas de couche ORM. Doit rester aligné sur
 * `supabase/migrations/20260819170000_create_workspaces.sql`.
 */
export type Workspace = {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
};

export type WorkspaceMember = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
};

/** Résumé d'un workspace tel qu'exposé à l'interface. */
export type WorkspaceSummary = Pick<Workspace, "id" | "name" | "slug">;

/** Appartenance de l'utilisateur courant à un workspace, avec son rôle. */
export type WorkspaceMembership = {
  role: WorkspaceRole;
  workspace: WorkspaceSummary;
};
