/**
 * Offres POSTYNC — SOURCE UNIQUE des prix et des quotas (C6).
 *
 * Ce fichier n'est plus une base de travail : ces valeurs sont APPLIQUÉES.
 * Les comptes sociaux, les publications mensuelles, le stockage et les sièges
 * d'équipe y sont tous lus, à l'écran comme au moment d'autoriser une action.
 * Les « Full Access » accordés via `workspace_entitlements` les contournent.
 *
 * FAIRE ÉVOLUER UNE OFFRE, c'est modifier ce fichier et rien d'autre. Aucune
 * limite n'est écrite en dur ailleurs — y compris côté base, où
 * `create_workspace_invitation` reçoit le quota en PARAMÈTRE plutôt que de le
 * relire, précisément pour qu'il n'existe pas de seconde vérité.
 *
 * Trois surfaces décrivent ces offres à l'utilisateur et doivent rester
 * complètes : l'écran Abonnement, le tableau d'administration, et les CGU —
 * qui les décrivent contractuellement. Une limite appliquée sans être
 * annoncée serait une limite subie.
 */

export type PlanKey = "free" | "creator" | "pro" | "agency";

export type PlanQuotas = {
  workspaces: number;
  /**
   * Sièges par workspace, propriétaire COMPRIS (C14).
   *
   * Validé le 2026-08-28 : Free 1, Creator 2, Pro 5, Agency 20. Free est donc
   * une offre solo — aucune invitation n'y est possible, et l'écran Équipe le
   * dit plutôt que de laisser l'utilisateur buter dessus.
   *
   * Les invitations EN ATTENTE occupent un siège : sans cela, inviter cinq
   * personnes sur une offre à trois passerait, et le dépassement
   * n'apparaîtrait qu'à l'acceptation.
   */
  members: number;
  socialAccounts: number;
  publicationsPerMonth: number;
  storageGb: number;
};

export type BillingInterval = "month" | "year";

export type Plan = {
  key: PlanKey;
  name: string;
  /** Prix mensuel en centimes d'euro (0 = gratuit). */
  monthlyPriceCents: number;
  /** Prix annuel en centimes d'euro (base : 2 mois offerts). */
  yearlyPriceCents: number;
  quotas: PlanQuotas;
  description: string;
};

export const PLANS: readonly Plan[] = [
  {
    key: "free",
    name: "Free",
    monthlyPriceCents: 0,
    yearlyPriceCents: 0,
    quotas: { workspaces: 1, members: 1, socialAccounts: 2, publicationsPerMonth: 10, storageGb: 1 },
    description: "Pour découvrir POSTYNC.",
  },
  {
    key: "creator",
    name: "Creator",
    monthlyPriceCents: 1290,
    yearlyPriceCents: 12900,
    quotas: { workspaces: 1, members: 2, socialAccounts: 6, publicationsPerMonth: 100, storageGb: 10 },
    description: "Pour un créateur qui publie régulièrement.",
  },
  {
    key: "pro",
    name: "Pro",
    monthlyPriceCents: 2990,
    yearlyPriceCents: 29900,
    quotas: { workspaces: 5, members: 5, socialAccounts: 20, publicationsPerMonth: 500, storageGb: 50 },
    description: "Pour les marques et les indépendants multi-comptes.",
  },
  {
    key: "agency",
    name: "Agency",
    monthlyPriceCents: 7990,
    yearlyPriceCents: 79900,
    quotas: { workspaces: 20, members: 20, socialAccounts: 100, publicationsPerMonth: 2000, storageGb: 250 },
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

/** Prix d'un plan pour une périodicité. */
export function planPriceCents(plan: Plan, interval: BillingInterval): number {
  return interval === "year" ? plan.yearlyPriceCents : plan.monthlyPriceCents;
}

/** Plans payants (le plan Free n'a pas de Price Stripe). */
export const PAID_PLAN_KEYS: readonly PlanKey[] = ["creator", "pro", "agency"];

/** « 12,90 € » / « 0 € » — formatage stable (fr-FR). */
export function formatPlanPrice(cents: number): string {
  if (cents === 0) return "0 €";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
