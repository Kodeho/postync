import "server-only";

import type { BillingInterval, PlanKey } from "@/config/plans";
import { PAID_PLAN_KEYS } from "@/config/plans";

/**
 * Configuration Stripe côté serveur.
 *
 * SEULE source des Price IDs : les variables d'environnement ci-dessous.
 * Aucun Price ID, plan ou identifiant fourni par le navigateur n'est jamais
 * utilisé tel quel — le client choisit un couple (plan, intervalle) qui est
 * validé puis résolu ici, côté serveur.
 */

export type PaidPlanKey = Exclude<PlanKey, "free">;

/** Variable d'environnement portant le Price ID d'un couple plan/intervalle. */
export const PRICE_ENV_NAMES: Record<PaidPlanKey, Record<BillingInterval, string>> = {
  creator: { month: "STRIPE_PRICE_CREATOR_MONTHLY", year: "STRIPE_PRICE_CREATOR_YEARLY" },
  pro: { month: "STRIPE_PRICE_PRO_MONTHLY", year: "STRIPE_PRICE_PRO_YEARLY" },
  agency: { month: "STRIPE_PRICE_AGENCY_MONTHLY", year: "STRIPE_PRICE_AGENCY_YEARLY" },
};

export function isPaidPlanKey(value: string): value is PaidPlanKey {
  return (PAID_PLAN_KEYS as readonly string[]).includes(value);
}

export function isBillingInterval(value: string): value is BillingInterval {
  return value === "month" || value === "year";
}

export function isStripeConfigured(): boolean {
  return (
    (process.env.STRIPE_SECRET_KEY ?? "").length > 0 &&
    (process.env.STRIPE_WEBHOOK_SECRET ?? "").length > 0
  );
}

/** Price ID d'un couple (plan, intervalle), ou null si non configuré. */
export function priceIdFor(plan: PaidPlanKey, interval: BillingInterval): string | null {
  const name = PRICE_ENV_NAMES[plan][interval];
  const value = process.env[name] ?? "";
  return value.length > 0 ? value : null;
}

/**
 * Table inverse Price ID -> (plan, intervalle), reconstruite à la demande à
 * partir de l'environnement. Sert au webhook pour identifier le plan d'un
 * abonnement Stripe. `null` si le Price ID est inconnu de la configuration.
 */
export function planFromPriceId(
  priceId: string,
): { planKey: PaidPlanKey; interval: BillingInterval } | null {
  for (const planKey of Object.keys(PRICE_ENV_NAMES) as PaidPlanKey[]) {
    for (const interval of ["month", "year"] as BillingInterval[]) {
      const configured = priceIdFor(planKey, interval);
      if (configured !== null && configured === priceId) {
        return { planKey, interval };
      }
    }
  }
  return null;
}

/** État de configuration des Price IDs (pour /admin/plans — noms, jamais de valeur). */
export function priceConfigurationStatus(): {
  planKey: PaidPlanKey;
  interval: BillingInterval;
  envName: string;
  configured: boolean;
}[] {
  const rows = [];
  for (const planKey of Object.keys(PRICE_ENV_NAMES) as PaidPlanKey[]) {
    for (const interval of ["month", "year"] as BillingInterval[]) {
      rows.push({
        planKey,
        interval,
        envName: PRICE_ENV_NAMES[planKey][interval],
        configured: priceIdFor(planKey, interval) !== null,
      });
    }
  }
  return rows;
}
