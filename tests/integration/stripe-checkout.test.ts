/**
 * C7 — checkout : C1–C5, autorisations RÉELLES contre Supabase.
 *
 * La chaîne complète de `startCheckoutAction` est exercée avec de vrais JWT
 * (owner, admin, member, tiers) : session -> memberships sous RLS -> rôle ->
 * validation du plan. Aucune clé Stripe n'étant configurée, un appel AUTORISÉ
 * s'arrête exactement à « facturation non configurée » — ce qui prouve que
 * l'autorisation est passée — tandis qu'un appel refusé échoue AVANT ce point
 * avec le message de refus. Aucun faux appel Stripe n'est simulé.
 */
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `vi.hoisted` s'exécute AVANT les imports : `src/lib/supabase/env.ts` capture
// les variables au chargement du module, elles doivent donc exister avant.
const env = await vi.hoisted(async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const file = resolve(process.cwd(), ".env.local");
  const vars: Record<string, string> = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(new RegExp("\r?\n"))) {
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  if (vars.NEXT_PUBLIC_SUPABASE_URL) process.env.NEXT_PUBLIC_SUPABASE_URL = vars.NEXT_PUBLIC_SUPABASE_URL;
  if (vars.NEXT_PUBLIC_SUPABASE_ANON_KEY) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = vars.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (vars.SUPABASE_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = vars.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  return vars;
});
const CONFIGURED = Boolean(
  env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY,
);
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };
const PASSWORD = `C7-${randomUUID()}`;

const USERS = {
  owner: "postync-c7-owner@example.com",
  wsAdmin: "postync-c7-wsadmin@example.com",
  member: "postync-c7-member@example.com",
  outsider: "postync-c7-outsider@example.com",
} as const;
type Key = keyof typeof USERS;

let admin: SupabaseClient;
const ids: Record<Key, string> = { owner: "", wsAdmin: "", member: "", outsider: "" };
const clients: Record<Key, SupabaseClient> = {} as Record<Key, SupabaseClient>;
let slug = "";

// Le client serveur (cookies) est remplacé par le client réel de l'acteur du
// test : tout le reste (memberships, RLS, rôles, validation) est authentique.
let currentActor: SupabaseClient;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentActor,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { startCheckoutAction, openBillingPortalAction } from "@/server/stripe/actions";
import { IDLE_BILLING_ACTION } from "@/server/stripe/action-state";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

async function checkoutAs(key: Key, entries: Record<string, string>) {
  currentActor = clients[key];
  return startCheckoutAction(IDLE_BILLING_ACTION, form(entries));
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const emails = new Set<string>(Object.values(USERS));
  for (const u of data.users.filter((u) => emails.has(u.email ?? ""))) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C7 — checkout (autorisations réelles)", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    for (const key of Object.keys(USERS) as Key[]) {
      const { data, error } = await admin.auth.admin.createUser({
        email: USERS[key],
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: `C7 ${key}` },
      });
      if (error) throw error;
      ids[key] = data.user.id;
      const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, NO_SESSION);
      const { error: signError } = await client.auth.signInWithPassword({
        email: USERS[key],
        password: PASSWORD,
      });
      if (signError) throw signError;
      clients[key] = client;
    }

    const { data: ws, error } = await clients.owner.rpc("create_workspace", { p_name: "C7 Billing WS" });
    if (error) throw error;
    slug = (ws as { slug: string }).slug;
    const workspaceId = (ws as { id: string }).id;
    await admin.from("workspace_members").insert([
      { workspace_id: workspaceId, user_id: ids.wsAdmin, role: "admin" },
      { workspace_id: workspaceId, user_id: ids.member, role: "member" },
    ]);
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  const NOT_CONFIGURED = "La facturation n'est pas encore configurée sur cette installation.";
  const NOT_ALLOWED = "Seul le propriétaire ou un admin du workspace peut gérer l'abonnement.";

  it("C1 — member : checkout refusé (avant toute considération Stripe)", async () => {
    const state = await checkoutAs("member", { workspaceSlug: slug, plan: "creator", interval: "month" });
    expect(state.error).toBe(NOT_ALLOWED);
  });

  it("C2 — owner : autorisation passée (bloqué uniquement par la configuration Stripe)", async () => {
    const state = await checkoutAs("owner", { workspaceSlug: slug, plan: "creator", interval: "month" });
    expect(state.error).toBe(NOT_CONFIGURED);
  });

  it("C3 — admin du workspace : autorisation passée", async () => {
    const state = await checkoutAs("wsAdmin", { workspaceSlug: slug, plan: "pro", interval: "year" });
    expect(state.error).toBe(NOT_CONFIGURED);
  });

  it("C4 — le navigateur ne choisit jamais un Price ID : plan/intervalle seuls, validés", async () => {
    // Avec Stripe « configuré » (valeurs factices), on atteint la validation
    // du plan — sans appel réseau : le refus intervient avant.
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy_for_validation";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy_for_validation";
    try {
      const forged = await checkoutAs("owner", {
        workspaceSlug: slug,
        plan: "price_1QForgedFromBrowser",
        interval: "month",
      });
      expect(forged.error).toBe("Offre invalide.");

      const freePlan = await checkoutAs("owner", { workspaceSlug: slug, plan: "free", interval: "month" });
      expect(freePlan.error).toBe("Offre invalide.");

      const badInterval = await checkoutAs("owner", { workspaceSlug: slug, plan: "creator", interval: "weekly" });
      expect(badInterval.error).toBe("Offre invalide.");

      // Plan valide mais Price ID non configuré côté serveur : refus propre.
      delete process.env.STRIPE_PRICE_CREATOR_MONTHLY;
      const missing = await checkoutAs("owner", { workspaceSlug: slug, plan: "creator", interval: "month" });
      expect(missing.error).toBe("L'offre Creator n'est pas encore disponible.");
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });

  it("C5 — un tiers ne peut pas facturer le workspace d'un autre (slug indiscernable)", async () => {
    const state = await checkoutAs("outsider", { workspaceSlug: slug, plan: "creator", interval: "month" });
    expect(state.error).toBe("Workspace introuvable.");
    const forged = await checkoutAs("outsider", { workspaceSlug: "n-existe-pas", plan: "creator", interval: "month" });
    expect(forged.error).toBe("Workspace introuvable.");
  });

  it("portail — mêmes règles : member refusé, owner sans customer -> message dédié", async () => {
    currentActor = clients.member;
    const denied = await openBillingPortalAction(IDLE_BILLING_ACTION, form({ workspaceSlug: slug }));
    expect(denied.error).toBe(NOT_ALLOWED);

    currentActor = clients.owner;
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy_for_validation";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy_for_validation";
    try {
      const noCustomer = await openBillingPortalAction(IDLE_BILLING_ACTION, form({ workspaceSlug: slug }));
      expect(noCustomer.error).toBe("Aucun abonnement à gérer pour ce workspace.");
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });
});
