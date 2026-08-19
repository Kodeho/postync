/**
 * Offres POSTYNC — configuration de référence (C6).
 *
 * Base de travail commerciale, volontairement isolée : ni les prix ni les
 * quotas ne sont immuables et rien ici n'est encore appliqué. C7 (Stripe) et
 * C8 (quotas) consommeront cette configuration ; les « Full Access » accordés
 * via `workspace_entitlements` contournent ces limites.
 */

export type PlanKey = "free" | "creator" | "pro" | "agency";

export type PlanQuotas = {
  workspaces: number;
  socialAccounts: number;
  publicationsPerMonth: number;
  storageGb: number;
};

export type Plan = {
  key: PlanKey;
  name: string;
  /** Prix mensuel en centimes d'euro (0 = gratuit). */
  monthlyPriceCents: number;
  quotas: PlanQuotas;
  description: string;
};

export const PLANS: readonly Plan[] = [
  {
    key: "free",
    name: "Free",
    monthlyPriceCents: 0,
    quotas: { workspaces: 1, socialAccounts: 2, publicationsPerMonth: 10, storageGb: 1 },
    description: "Pour découvrir POSTYNC.",
  },
  {
    key: "creator",
    name: "Creator",
    monthlyPriceCents: 1290,
    quotas: { workspaces: 1, socialAccounts: 6, publicationsPerMonth: 100, storageGb: 10 },
    description: "Pour un créateur qui publie régulièrement.",
  },
  {
    key: "pro",
    name: "Pro",
    monthlyPriceCents: 2990,
    quotas: { workspaces: 5, socialAccounts: 20, publicationsPerMonth: 500, storageGb: 50 },
    description: "Pour les marques et les indépendants multi-comptes.",
  },
  {
    key: "agency",
    name: "Agency",
    monthlyPriceCents: 7990,
    quotas: { workspaces: 20, socialAccounts: 100, publicationsPerMonth: 2000, storageGb: 250 },
    description: "Pour les agences gérant de nombreux clients.",
  },
];

export function getPlan(key: PlanKey): Plan {
  const plan = PLANS.find((p) => p.key === key);
  if (!plan) {
    throw new Error(`Plan inconnu : ${key}`);
  }
  return plan;
}

/** « 12,90 € » / « 0 € » — formatage stable (fr-FR). */
export function formatPlanPrice(cents: number): string {
  if (cents === 0) return "0 €";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
