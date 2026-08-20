import type { AdminActor } from "./authorization";
import {
  computeMrrCents,
  countActiveSubscriptions,
  type BillingStatRow,
} from "@/server/billing/access";

/** Lectures de facturation pour l'administration (RPC security definer). */

export type AdminSubscriptionRow = {
  id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  owner_email: string;
  plan_key: string;
  billing_interval: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  full_access: boolean;
  created_at: string;
  total_count: number;
};

export async function listSubscriptions(
  actor: AdminActor,
  page = 1,
  pageSize = 50,
): Promise<{ rows: AdminSubscriptionRow[]; total: number }> {
  const { data, error } = await actor.supabase.rpc("admin_list_subscriptions", {
    p_limit: pageSize,
    p_offset: (Math.max(1, page) - 1) * pageSize,
  });
  if (error) {
    console.error(`[admin:subscriptions] ${error.code ?? "unknown"}: ${error.message}`);
  }
  const rows = (data ?? []) as AdminSubscriptionRow[];
  return { rows, total: rows[0]?.total_count ?? 0 };
}

export async function getBillingStats(
  actor: AdminActor,
): Promise<{ mrrCents: number; activeSubscriptions: number } | null> {
  const { data, error } = await actor.supabase.rpc("admin_billing_stats");
  if (error) {
    console.error(`[admin:billing-stats] ${error.code ?? "unknown"}: ${error.message}`);
    return null;
  }
  const rows = (data ?? []) as BillingStatRow[];
  return {
    mrrCents: computeMrrCents(rows),
    activeSubscriptions: countActiveSubscriptions(rows),
  };
}
