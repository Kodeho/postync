import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type { PlatformRole } from "@/types/platform-role";

import {
  PLATFORM_STAFF_ROLES,
  isPlatformRole,
  type AdminAction,
  can,
} from "./permissions";

/**
 * Autorisation de l'administration Kodeho.
 *
 * Chaîne obligatoire avant toute opération admin :
 *
 *   session (getUser) -> profil -> account_status = active -> platform_role
 *   -> permission -> opération (RPC admin_*, qui refait le même contrôle en base)
 *
 * Le rôle workspace n'intervient jamais. Un refus produit un 404 : on ne
 * révèle pas l'existence de l'administration à un utilisateur standard.
 */

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type AdminActor = {
  supabase: SupabaseServerClient;
  user: User;
  role: PlatformRole;
  displayName: string | null;
};

/** Profil de l'utilisateur courant (mémoïsé par requête). */
const getCurrentStaff = cache(async (): Promise<AdminActor | null> => {
  if (!isSupabaseConfigured()) {
    return null;
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return null;
  }

  // RLS : un utilisateur lit toujours son propre profil.
  const { data: profile } = await supabase
    .from("profiles")
    .select("platform_role, account_status, display_name")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || profile.account_status !== "active") {
    return null;
  }
  const role = profile.platform_role;
  if (!isPlatformRole(role)) {
    return null;
  }
  return {
    supabase,
    user,
    role,
    displayName: profile.display_name?.trim() || null,
  };
});

/**
 * Exige l'un des rôles plateforme donnés. Sans session : /login. Avec une
 * session mais sans le rôle (ou compte non actif) : 404.
 */
export async function requirePlatformRole(
  allowed: readonly PlatformRole[] = PLATFORM_STAFF_ROLES,
): Promise<AdminActor> {
  if (!isSupabaseConfigured()) {
    redirect("/login");
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const actor = await getCurrentStaff();
  if (!actor || !allowed.includes(actor.role)) {
    notFound();
  }
  return actor;
}

export async function requireSuperAdmin(): Promise<AdminActor> {
  return requirePlatformRole(["super_admin"]);
}

/** Exige une permission précise de la matrice. */
export async function requireAdminAction(action: AdminAction): Promise<AdminActor> {
  const actor = await requirePlatformRole();
  if (!can(actor.role, action)) {
    notFound();
  }
  return actor;
}
