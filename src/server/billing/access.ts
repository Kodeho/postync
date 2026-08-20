import {
  getPlan,
  type BillingInterval,
  type Plan,
  type PlanKey,
  type PlanQuotas,
} from "@/config/plans";

/**
 * Résolution de l'accès commercial d'un workspace — logique PURE.
 *
 * Priorité (docs/BILLING.md) :
 *
 *   1. Full Access Kodeho valide  -> accès maximal (quotas du plan Agency)
 *   2. abonnement Stripe vivant   -> plan de l'abonnement
 *   3. sinon                      -> Free
 *
 * Full Access fonctionne sans Stripe et reste prioritaire sur tout
 * abonnement. Quand il expire, le workspace retombe automatiquement sur son
 * abonnement actif, sinon sur Free.
 */

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export type SubscriptionSnapshot = {
  planKey: PlanKey | "unknown";
  interval: BillingInterval | "unknown";
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type EntitlementSnapshot = {
  accessMode: "standard" | "full_access";
  startsAt: string | null;
  endsAt: string | null;
};

export type AccessSource = "full_access" | "subscription" | "free";

export type WorkspaceAccess = {
  source: AccessSource;
  planKey: PlanKey;
  plan: Plan;
  quotas: PlanQuotas;
  /**
   * Politique past_due (V1, documentée) : au premier échec bancaire, l'accès
   * payé est CONSERVÉ temporairement et un avertissement est affiché. Stripe
   * relance les paiements ; si l'abonnement finit `canceled`/`unpaid`, le
   * workspace retombe sur Free au prochain calcul.
   */
  paymentWarning: boolean;
  /** Abonnement annulé mais payé jusqu'à `currentPeriodEnd`. */
  endsAt: string | null;
};

/**
 * Statuts donnant droit au plan payé. `past_due` conserve l'accès (politique
 * V1 ci-dessus) ; `paused`, `incomplete`, `canceled`, `unpaid` et
 * `incomplete_expired` ne donnent aucun droit.
 */
const ENTITLED_STATUSES: readonly SubscriptionStatus[] = ["active", "trialing", "past_due"];

export function isSubscriptionEntitled(status: SubscriptionStatus): boolean {
  return ENTITLED_STATUSES.includes(status);
}

/** Statuts comptés dans le MRR et les « abonnements actifs » (règle documentée). */
const MRR_STATUSES: readonly SubscriptionStatus[] = ["active", "trialing"];

export function isFullAccessValid(
  entitlement: EntitlementSnapshot | null,
  now: number,
): boolean {
  if (!entitlement || entitlement.accessMode !== "full_access") return false;
  if (entitlement.startsAt && new Date(entitlement.startsAt).getTime() > now) return false;
  if (entitlement.endsAt && new Date(entitlement.endsAt).getTime() <= now) return false;
  return true;
}

export function resolveWorkspaceAccess(input: {
  entitlement: EntitlementSnapshot | null;
  subscription: SubscriptionSnapshot | null;
  now?: number;
}): WorkspaceAccess {
  const now = input.now ?? Date.now();

  // 1. Full Access Kodeho : accès maximal, indépendant de Stripe.
  if (isFullAccessValid(input.entitlement, now)) {
    const plan = getPlan("agency");
    return {
      source: "full_access",
      planKey: "agency",
      plan,
      quotas: plan.quotas,
      paymentWarning: false,
      endsAt: input.entitlement?.endsAt ?? null,
    };
  }

  // 2. Abonnement Stripe vivant.
  const sub = input.subscription;
  if (sub && isSubscriptionEntitled(sub.status) && isKnownPlanKey(sub.planKey)) {
    const plan = getPlan(sub.planKey);
    return {
      source: "subscription",
      planKey: sub.planKey,
      plan,
      quotas: plan.quotas,
      paymentWarning: sub.status === "past_due",
      endsAt: sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : null,
    };
  }

  // 3. Free.
  const plan = getPlan("free");
  return {
    source: "free",
    planKey: "free",
    plan,
    quotas: plan.quotas,
    paymentWarning: false,
    endsAt: null,
  };
}

function isKnownPlanKey(value: string): value is PlanKey {
  return value === "free" || value === "creator" || value === "pro" || value === "agency";
}

// ---------------------------------------------------------------------------
// Downgrade
// ---------------------------------------------------------------------------

/**
 * Comparaison d'un usage courant aux quotas d'un plan. POSTYNC ne supprime
 * JAMAIS de données lors d'un downgrade : les dépassements bloquent seulement
 * les nouvelles créations et déclenchent une alerte.
 */
export type QuotaUsage = Partial<PlanQuotas>;

export type QuotaOverage = { quota: keyof PlanQuotas; used: number; limit: number };

export function quotaOverages(usage: QuotaUsage, quotas: PlanQuotas): QuotaOverage[] {
  const overages: QuotaOverage[] = [];
  for (const key of Object.keys(quotas) as (keyof PlanQuotas)[]) {
    const used = usage[key];
    if (typeof used === "number" && used > quotas[key]) {
      overages.push({ quota: key, used, limit: quotas[key] });
    }
  }
  return overages;
}

/** Une nouvelle création est-elle permise pour ce compteur ? (usage < limite) */
export function canCreate(usage: number, limit: number): boolean {
  return usage < limit;
}

// ---------------------------------------------------------------------------
// MRR
// ---------------------------------------------------------------------------

export type BillingStatRow = {
  plan_key: string;
  billing_interval: string;
  status: string;
  cnt: number;
};

/**
 * MRR en centimes — règle documentée (docs/BILLING.md) :
 *   * abonnements `active` et `trialing` uniquement ;
 *   * mensuel : prix mensuel du plan ; annuel : prix annuel / 12 (arrondi
 *     au centime inférieur par abonnement) ;
 *   * prix issus de `src/config/plans.ts` (référence commerciale, pas des
 *     montants réellement facturés par Stripe) ;
 *   * plans inconnus ignorés.
 */
export function computeMrrCents(rows: BillingStatRow[]): number {
  let total = 0;
  for (const row of rows) {
    if (!MRR_STATUSES.includes(row.status as SubscriptionStatus)) continue;
    if (!isKnownPlanKey(row.plan_key) || row.plan_key === "free") continue;
    const plan = getPlan(row.plan_key);
    const monthly =
      row.billing_interval === "year"
        ? Math.floor(plan.yearlyPriceCents / 12)
        : plan.monthlyPriceCents;
    total += monthly * row.cnt;
  }
  return total;
}

/** Nombre d'abonnements comptés comme actifs (même règle que le MRR). */
export function countActiveSubscriptions(rows: BillingStatRow[]): number {
  return rows
    .filter((row) => MRR_STATUSES.includes(row.status as SubscriptionStatus))
    .reduce((sum, row) => sum + row.cnt, 0);
}

// ---------------------------------------------------------------------------
// Affichage des statuts
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: "Période d'essai",
  active: "Actif",
  past_due: "Paiement en retard",
  canceled: "Annulé",
  unpaid: "Impayé",
  incomplete: "Paiement incomplet",
  incomplete_expired: "Paiement expiré",
  paused: "En pause",
};

export function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return value in SUBSCRIPTION_STATUS_LABELS;
}
