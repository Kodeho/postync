/**
 * C7 — facturation : résolution d'accès (Full Access → abonnement → Free),
 * mapping Price ID → plan, quotas/downgrade, MRR, politique past_due.
 * Logique pure + configuration lue depuis un environnement contrôlé.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPlan } from "@/config/plans";
import {
  computeMrrCents,
  countActiveSubscriptions,
  canCreate,
  isFullAccessValid,
  isSubscriptionEntitled,
  quotaOverages,
  resolveWorkspaceAccess,
  type EntitlementSnapshot,
  type SubscriptionSnapshot,
} from "@/server/billing/access";
import {
  PRICE_ENV_NAMES,
  isPaidPlanKey,
  planFromPriceId,
  priceConfigurationStatus,
  priceIdFor,
} from "@/server/stripe/config";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const FUTURE = "2026-12-31T00:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";

function fullAccess(endsAt: string | null): EntitlementSnapshot {
  return { accessMode: "full_access", startsAt: PAST, endsAt };
}

function sub(partial: Partial<SubscriptionSnapshot>): SubscriptionSnapshot {
  return {
    planKey: "creator",
    interval: "month",
    status: "active",
    currentPeriodEnd: FUTURE,
    cancelAtPeriodEnd: false,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// F1–F4 : priorité commerciale
// ---------------------------------------------------------------------------
describe("resolveWorkspaceAccess — priorité Full Access > abonnement > Free", () => {
  it("F1 — sans abonnement + Full Access : accès maximal (quotas Agency)", () => {
    const access = resolveWorkspaceAccess({ entitlement: fullAccess(null), subscription: null, now: NOW });
    expect(access.source).toBe("full_access");
    expect(access.quotas).toEqual(getPlan("agency").quotas);
    expect(access.paymentWarning).toBe(false);
  });

  it("F2 — abonnement Creator + Full Access : Full Access prioritaire", () => {
    const access = resolveWorkspaceAccess({
      entitlement: fullAccess(FUTURE),
      subscription: sub({ planKey: "creator" }),
      now: NOW,
    });
    expect(access.source).toBe("full_access");
    expect(access.planKey).toBe("agency");
    expect(access.endsAt).toBe(FUTURE);
  });

  it("F3 — Full Access expiré + Creator actif : Creator", () => {
    const access = resolveWorkspaceAccess({
      entitlement: fullAccess(PAST),
      subscription: sub({ planKey: "creator" }),
      now: NOW,
    });
    expect(access.source).toBe("subscription");
    expect(access.planKey).toBe("creator");
    expect(access.quotas).toEqual(getPlan("creator").quotas);
  });

  it("F4 — Full Access expiré + aucun abonnement : Free", () => {
    const access = resolveWorkspaceAccess({ entitlement: fullAccess(PAST), subscription: null, now: NOW });
    expect(access.source).toBe("free");
    expect(access.quotas).toEqual(getPlan("free").quotas);
  });

  it("entitlement standard : ignoré", () => {
    expect(isFullAccessValid({ accessMode: "standard", startsAt: PAST, endsAt: null }, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Statuts et politique past_due
// ---------------------------------------------------------------------------
describe("statuts d'abonnement", () => {
  it("active, trialing et past_due donnent droit au plan ; les autres non", () => {
    expect(isSubscriptionEntitled("active")).toBe(true);
    expect(isSubscriptionEntitled("trialing")).toBe(true);
    expect(isSubscriptionEntitled("past_due")).toBe(true);
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"] as const) {
      expect(isSubscriptionEntitled(status), status).toBe(false);
    }
  });

  it("past_due — accès conservé AVEC avertissement (politique V1)", () => {
    const access = resolveWorkspaceAccess({
      entitlement: null,
      subscription: sub({ status: "past_due" }),
      now: NOW,
    });
    expect(access.source).toBe("subscription");
    expect(access.planKey).toBe("creator");
    expect(access.paymentWarning).toBe(true);
  });

  it("canceled / unpaid : retour à Free", () => {
    for (const status of ["canceled", "unpaid"] as const) {
      const access = resolveWorkspaceAccess({ entitlement: null, subscription: sub({ status }), now: NOW });
      expect(access.source, status).toBe("free");
    }
  });

  it("annulation en fin de période : accès conservé, échéance exposée", () => {
    const access = resolveWorkspaceAccess({
      entitlement: null,
      subscription: sub({ cancelAtPeriodEnd: true, currentPeriodEnd: FUTURE }),
      now: NOW,
    });
    expect(access.source).toBe("subscription");
    expect(access.endsAt).toBe(FUTURE);
  });

  it("plan_key inconnu : aucun droit implicite (Free)", () => {
    const access = resolveWorkspaceAccess({
      entitlement: null,
      subscription: sub({ planKey: "unknown" }),
      now: NOW,
    });
    expect(access.source).toBe("free");
  });
});

// ---------------------------------------------------------------------------
// Downgrade : jamais de suppression, blocage des créations, alerte
// ---------------------------------------------------------------------------
describe("downgrade Pro -> Creator", () => {
  it("détecte les dépassements sans rien supprimer", () => {
    const creator = getPlan("creator").quotas;
    const overages = quotaOverages({ workspaces: 3, socialAccounts: 12 }, creator);
    expect(overages).toEqual([
      { quota: "workspaces", used: 3, limit: 1 },
      { quota: "socialAccounts", used: 12, limit: 6 },
    ]);
  });

  it("bloque les nouvelles créations au-delà de la limite", () => {
    expect(canCreate(0, 1)).toBe(true);
    expect(canCreate(1, 1)).toBe(false);
    expect(canCreate(6, 6)).toBe(false);
  });

  it("aucun dépassement : aucune alerte", () => {
    expect(quotaOverages({ workspaces: 1 }, getPlan("creator").quotas)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MRR — règle documentée : active + trialing ; annuel / 12
// ---------------------------------------------------------------------------
describe("MRR", () => {
  it("additionne les abonnements actifs/trialing au prix de référence", () => {
    const rows = [
      { plan_key: "creator", billing_interval: "month", status: "active", cnt: 2 }, // 2 × 1290
      { plan_key: "pro", billing_interval: "year", status: "active", cnt: 1 }, // 29900/12 = 2491
      { plan_key: "agency", billing_interval: "month", status: "trialing", cnt: 1 }, // 7990
      { plan_key: "creator", billing_interval: "month", status: "canceled", cnt: 5 }, // ignoré
      { plan_key: "creator", billing_interval: "month", status: "past_due", cnt: 3 }, // ignoré (MRR)
      { plan_key: "unknown", billing_interval: "month", status: "active", cnt: 9 }, // ignoré du MRR
    ];
    expect(computeMrrCents(rows)).toBe(2 * 1290 + Math.floor(29900 / 12) + 7990);
    // Le compteur inclut les plans non mappés : ce sont de vrais abonnements.
    expect(countActiveSubscriptions(rows)).toBe(13);
  });

  it("MRR nul sans abonnement", () => {
    expect(computeMrrCents([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Mapping Price ID <-> plan (serveur uniquement)
// ---------------------------------------------------------------------------
describe("configuration des Price IDs", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const plan of Object.values(PRICE_ENV_NAMES)) {
      for (const name of Object.values(plan)) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("plan + intervalle -> Price ID depuis l'environnement uniquement", () => {
    process.env.STRIPE_PRICE_CREATOR_MONTHLY = "price_test_creator_m";
    process.env.STRIPE_PRICE_PRO_YEARLY = "price_test_pro_y";

    expect(priceIdFor("creator", "month")).toBe("price_test_creator_m");
    expect(priceIdFor("pro", "year")).toBe("price_test_pro_y");
    expect(priceIdFor("agency", "month")).toBeNull();
  });

  it("C4 — un Price ID arbitraire du client n'est jamais reconnu", () => {
    process.env.STRIPE_PRICE_CREATOR_MONTHLY = "price_test_creator_m";

    expect(planFromPriceId("price_test_creator_m")).toEqual({ planKey: "creator", interval: "month" });
    expect(planFromPriceId("price_forge_du_client")).toBeNull();
    expect(planFromPriceId("")).toBeNull();
    // Aucune correspondance quand rien n'est configuré.
    delete process.env.STRIPE_PRICE_CREATOR_MONTHLY;
    expect(planFromPriceId("price_test_creator_m")).toBeNull();
  });

  it("free n'est jamais un plan payant ; 6 Price IDs référencés", () => {
    expect(isPaidPlanKey("free")).toBe(false);
    expect(isPaidPlanKey("creator")).toBe(true);
    const status = priceConfigurationStatus();
    expect(status).toHaveLength(6);
    expect(status.every((row) => row.configured === false)).toBe(true);
    expect(new Set(status.map((r) => r.envName)).size).toBe(6);
  });
});
