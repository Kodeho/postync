import type { AdminActor } from "./authorization";

/**
 * Lectures d'administration. Chaque fonction appelle une RPC `security
 * definer` qui revérifie le platform_role de l'appelant en base : un appel
 * non autorisé échoue avec 42501, quoi qu'ait décidé l'application.
 */

export type AccountStatus = "active" | "suspended" | "disabled";
export type AccessMode = "standard" | "full_access";

export type AdminUserRow = {
  id: string;
  email: string;
  display_name: string | null;
  platform_role: string;
  account_status: AccountStatus;
  workspace_count: number;
  created_at: string;
  last_sign_in_at: string | null;
  total_count: number;
};

export type AdminUserDetail = {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  platform_role: string;
  account_status: AccountStatus;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
};

export type AdminUserWorkspace = {
  workspace_id: string;
  name: string;
  slug: string;
  role: string;
  access_mode: AccessMode;
  ends_at: string | null;
  /** Full Access effectif (mode full_access et non expiré), calculé hors rendu. */
  access_active: boolean;
};

export type AdminWorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  owner_email: string;
  owner_name: string | null;
  member_count: number;
  access_mode: AccessMode;
  ends_at: string | null;
  access_active: boolean;
  created_at: string;
  total_count: number;
};

export type AdminWorkspaceDetail = {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  owner_email: string;
  owner_name: string | null;
  access_mode: AccessMode;
  starts_at: string | null;
  ends_at: string | null;
  reason: string | null;
  granted_by: string | null;
  granted_by_email: string | null;
  created_at: string;
  access_active: boolean;
};

export type AdminWorkspaceMember = {
  user_id: string;
  email: string;
  display_name: string | null;
  role: string;
  account_status: AccountStatus;
  created_at: string;
};

export type AdminAuditRow = {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  total_count: number;
};

export type DashboardStats = {
  users_total: number;
  users_active: number;
  users_suspended: number;
  workspaces_total: number;
  full_access_workspaces: number;
};

export type Paged<T> = { rows: T[]; total: number };

function logError(scope: string, error: { code?: string; message: string } | null) {
  if (error) {
    console.error(`[admin:${scope}] ${error.code ?? "unknown"}: ${error.message}`);
  }
}

/** Full Access effectif : mode full_access et date de fin absente ou future. */
export function isFullAccessActive(
  mode: string,
  endsAt: string | null,
  now: number = Date.now(),
): boolean {
  if (mode !== "full_access") return false;
  if (!endsAt) return true;
  const end = new Date(endsAt).getTime();
  return Number.isNaN(end) ? false : end > now;
}

function withAccessFlag<T extends { access_mode: string; ends_at: string | null }>(
  row: T,
): T & { access_active: boolean } {
  return { ...row, access_active: isFullAccessActive(row.access_mode, row.ends_at) };
}

function paged<T extends { total_count: number }>(rows: T[] | null): Paged<T> {
  const list = rows ?? [];
  return { rows: list, total: list[0]?.total_count ?? 0 };
}

export async function getDashboardStats(actor: AdminActor): Promise<DashboardStats | null> {
  const { data, error } = await actor.supabase.rpc("admin_dashboard_stats");
  logError("dashboard", error);
  const rows = (data ?? []) as DashboardStats[];
  return rows[0] ?? null;
}

export type UserFilters = {
  search?: string;
  status?: AccountStatus | null;
  role?: string | null;
  page?: number;
  pageSize?: number;
};

export async function listUsers(actor: AdminActor, filters: UserFilters): Promise<Paged<AdminUserRow>> {
  const pageSize = filters.pageSize ?? 25;
  const page = Math.max(1, filters.page ?? 1);
  const { data, error } = await actor.supabase.rpc("admin_list_users", {
    p_search: filters.search?.trim() || null,
    p_status: filters.status ?? null,
    p_role: filters.role ?? null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  logError("users.list", error);
  return paged((data ?? null) as AdminUserRow[] | null);
}

export async function getUser(actor: AdminActor, userId: string): Promise<AdminUserDetail | null> {
  const { data, error } = await actor.supabase.rpc("admin_get_user", { p_user_id: userId });
  logError("users.get", error);
  const rows = (data ?? []) as AdminUserDetail[];
  return rows[0] ?? null;
}

export async function listUserWorkspaces(
  actor: AdminActor,
  userId: string,
): Promise<AdminUserWorkspace[]> {
  const { data, error } = await actor.supabase.rpc("admin_user_workspaces", {
    p_user_id: userId,
  });
  logError("users.workspaces", error);
  return ((data ?? []) as Omit<AdminUserWorkspace, "access_active">[]).map(withAccessFlag);
}

export type WorkspaceFilters = { search?: string; page?: number; pageSize?: number };

export async function listWorkspaces(
  actor: AdminActor,
  filters: WorkspaceFilters,
): Promise<Paged<AdminWorkspaceRow>> {
  const pageSize = filters.pageSize ?? 25;
  const page = Math.max(1, filters.page ?? 1);
  const { data, error } = await actor.supabase.rpc("admin_list_workspaces", {
    p_search: filters.search?.trim() || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  logError("workspaces.list", error);
  const rows = ((data ?? []) as Omit<AdminWorkspaceRow, "access_active">[]).map(withAccessFlag);
  return paged(rows);
}

export async function getWorkspace(
  actor: AdminActor,
  workspaceId: string,
): Promise<AdminWorkspaceDetail | null> {
  const { data, error } = await actor.supabase.rpc("admin_get_workspace", {
    p_workspace_id: workspaceId,
  });
  logError("workspaces.get", error);
  const rows = (data ?? []) as Omit<AdminWorkspaceDetail, "access_active">[];
  return rows[0] ? withAccessFlag(rows[0]) : null;
}

export async function listWorkspaceMembers(
  actor: AdminActor,
  workspaceId: string,
): Promise<AdminWorkspaceMember[]> {
  const { data, error } = await actor.supabase.rpc("admin_workspace_members", {
    p_workspace_id: workspaceId,
  });
  logError("workspaces.members", error);
  return (data ?? []) as AdminWorkspaceMember[];
}

export async function listAuditLogs(
  actor: AdminActor,
  page = 1,
  pageSize = 50,
): Promise<Paged<AdminAuditRow>> {
  const { data, error } = await actor.supabase.rpc("admin_list_audit_logs", {
    p_limit: pageSize,
    p_offset: (Math.max(1, page) - 1) * pageSize,
  });
  logError("audit.list", error);
  return paged((data ?? null) as AdminAuditRow[] | null);
}
