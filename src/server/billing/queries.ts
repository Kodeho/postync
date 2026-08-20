import type { SupabaseClient } from "@supabase/supabase-js";

import {
  resolveWorkspaceAccess,
  isSubscriptionStatus,
  type EntitlementSnapshot,
  type SubscriptionSnapshot,
  type WorkspaceAccess,
} from "./access";

/**
 * Lectures de facturation côté serveur, sous RLS : un membre ne lit que
 * l'abonnement et l'entitlement de SES workspaces (politiques C6/C7).
 */

export type WorkspaceSubscriptionRow = {
  plan_key: string;
  billing_interval: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

/** Statuts « vivants » : au plus une ligne par workspace (index partiel C7). */
const LIVE_STATUSES = ["trialing", "active", "past_due", "unpaid", "paused", "incomplete"];

export async function getWorkspaceSubscription(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<SubscriptionSnapshot | null> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("plan_key, billing_interval, status, current_period_end, cancel_at_period_end")
    .eq("workspace_id", workspaceId)
    .in("status", LIVE_STATUSES)
    .maybeSingle();

  if (error) {
    console.error(`[billing:subscription] ${error.code ?? "unknown"}: ${error.message}`);
    return null;
  }
  if (!data || !isSubscriptionStatus(data.status)) {
    return null;
  }
  return {
    planKey: data.plan_key as SubscriptionSnapshot["planKey"],
    interval: data.billing_interval as SubscriptionSnapshot["interval"],
    status: data.status,
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end,
  };
}

export async function getWorkspaceEntitlement(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<EntitlementSnapshot | null> {
  const { data, error } = await supabase
    .from("workspace_entitlements")
    .select("access_mode, starts_at, ends_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    console.error(`[billing:entitlement] ${error.code ?? "unknown"}: ${error.message}`);
    return null;
  }
  if (!data) return null;
  return {
    accessMode: data.access_mode as EntitlementSnapshot["accessMode"],
    startsAt: data.starts_at,
    endsAt: data.ends_at,
  };
}

/**
 * Accès commercial effectif d'un workspace :
 * Full Access valide -> abonnement vivant -> Free (voir access.ts).
 */
export async function getWorkspaceAccess(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<{ access: WorkspaceAccess; subscription: SubscriptionSnapshot | null }> {
  const [entitlement, subscription] = await Promise.all([
    getWorkspaceEntitlement(supabase, workspaceId),
    getWorkspaceSubscription(supabase, workspaceId),
  ]);
  return { access: resolveWorkspaceAccess({ entitlement, subscription }), subscription };
}
