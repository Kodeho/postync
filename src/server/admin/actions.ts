"use server";

import { revalidatePath } from "next/cache";

import { requirePlatformRole } from "./authorization";
import {
  PLATFORM_ADMIN_ROLES,
  decideRoleChange,
  decideStatusChange,
  isPlatformRole,
} from "./permissions";
import { getUser } from "./queries";
import type { AdminActionState } from "./action-state";

/**
 * Server Actions d'administration.
 *
 * Chaque action :
 *   1. exige un rôle plateforme (session revalidée + profil actif) ;
 *   2. relit la cible en base (jamais confiance aux champs cachés du
 *      formulaire pour le rôle ou le statut de la cible) ;
 *   3. applique la matrice applicative (refus précoce, message clair) ;
 *   4. appelle la RPC `security definer`, qui réapplique la matrice en base
 *      et journalise dans admin_audit_logs ;
 *   5. revalide les pages concernées.
 *
 * Jamais de PATCH direct sur `profiles` ou `workspace_entitlements`.
 */

const GENERIC_ERROR = "L'opération a échoué. Veuillez réessayer.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): AdminActionState {
  return { ok: false, message };
}

function readUuid(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return UUID_PATTERN.test(value) ? value : null;
}

/** Traduit une erreur PostgREST/PostgreSQL en message utilisateur, sans détail technique. */
function rpcErrorMessage(error: { code?: string; message: string }): string {
  console.error(`[admin:action] ${error.code ?? "unknown"}: ${error.message}`);
  switch (error.code) {
    case "42501":
      return "Action refusée : vos droits ne le permettent pas.";
    case "23514":
      return "Action refusée : il doit toujours rester au moins un super_admin.";
    case "22023":
      return "Paramètres invalides.";
    case "P0002":
      return "Cible introuvable.";
    default:
      return GENERIC_ERROR;
  }
}

async function setStatus(formData: FormData, status: "active" | "suspended"): Promise<AdminActionState> {
  const actor = await requirePlatformRole(PLATFORM_ADMIN_ROLES);
  const userId = readUuid(formData, "userId");
  if (!userId) return fail("Utilisateur invalide.");

  const target = await getUser(actor, userId);
  if (!target || !isPlatformRole(target.platform_role)) return fail("Utilisateur introuvable.");

  const decision = decideStatusChange({
    actorRole: actor.role,
    targetRole: target.platform_role,
    isSelf: target.id === actor.user.id,
  });
  if (!decision.allowed) return fail(decision.reason);

  const { error } = await actor.supabase.rpc("admin_set_account_status", {
    p_user_id: userId,
    p_status: status,
  });
  if (error) return fail(rpcErrorMessage(error));

  revalidatePath("/admin", "layout");
  return {
    ok: true,
    message: status === "suspended" ? "Compte suspendu." : "Compte réactivé.",
  };
}

export async function suspendUserAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  return setStatus(formData, "suspended");
}

export async function reactivateUserAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  return setStatus(formData, "active");
}

export async function setPlatformRoleAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const actor = await requirePlatformRole(PLATFORM_ADMIN_ROLES);
  const userId = readUuid(formData, "userId");
  const newRole = String(formData.get("role") ?? "");
  if (!userId) return fail("Utilisateur invalide.");
  if (!isPlatformRole(newRole)) return fail("Rôle invalide.");

  const target = await getUser(actor, userId);
  if (!target || !isPlatformRole(target.platform_role)) return fail("Utilisateur introuvable.");

  const decision = decideRoleChange({
    actorRole: actor.role,
    targetRole: target.platform_role,
    newRole,
    isSelf: target.id === actor.user.id,
  });
  if (!decision.allowed) return fail(decision.reason);

  const { error } = await actor.supabase.rpc("admin_set_platform_role", {
    p_user_id: userId,
    p_role: newRole,
  });
  if (error) return fail(rpcErrorMessage(error));

  revalidatePath("/admin", "layout");
  return { ok: true, message: `Rôle plateforme : ${newRole}.` };
}

export async function grantFullAccessAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const actor = await requirePlatformRole(PLATFORM_ADMIN_ROLES);
  const workspaceId = readUuid(formData, "workspaceId");
  if (!workspaceId) return fail("Workspace invalide.");

  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length > 500) return fail("La raison ne doit pas dépasser 500 caractères.");

  const rawEnds = String(formData.get("endsAt") ?? "").trim();
  let endsAt: string | null = null;
  if (rawEnds) {
    // Champ <input type="date"> : fin de journée UTC de la date choisie.
    const parsed = new Date(`${rawEnds}T23:59:59.000Z`);
    if (Number.isNaN(parsed.getTime())) return fail("Date de fin invalide.");
    if (parsed.getTime() <= Date.now()) return fail("La date de fin doit être dans le futur.");
    endsAt = parsed.toISOString();
  }

  const { error } = await actor.supabase.rpc("admin_grant_full_access", {
    p_workspace_id: workspaceId,
    p_ends_at: endsAt,
    p_reason: reason || null,
  });
  if (error) return fail(rpcErrorMessage(error));

  revalidatePath("/admin", "layout");
  return { ok: true, message: "Full Access accordé." };
}

export async function revokeFullAccessAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const actor = await requirePlatformRole(PLATFORM_ADMIN_ROLES);
  const workspaceId = readUuid(formData, "workspaceId");
  if (!workspaceId) return fail("Workspace invalide.");
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length > 500) return fail("La raison ne doit pas dépasser 500 caractères.");

  const { error } = await actor.supabase.rpc("admin_revoke_full_access", {
    p_workspace_id: workspaceId,
    p_reason: reason || null,
  });
  if (error) return fail(rpcErrorMessage(error));

  revalidatePath("/admin", "layout");
  return { ok: true, message: "Full Access retiré." };
}
