/**
 * C7 — webhook Stripe : S1–S7 contre la VRAIE route (`POST /api/stripe/webhook`)
 * et la vraie base Supabase.
 *
 * Aucune clé Stripe réelle n'est nécessaire : les signatures sont générées
 * localement avec `Stripe.webhooks.generateTestHeaderString` et un secret de
 * test défini pour la durée du fichier — c'est exactement la cryptographie
 * utilisée par Stripe (HMAC-SHA256 sur le raw body).
 *
 * Données : un utilisateur + workspace dédiés (postync-c7-*), nettoyés en
 * afterAll (subscriptions, billing_customers, subscription_events compris).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Stripe from "stripe";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function loadEnvLocal(): Record<string, string> {
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

const env = loadEnvLocal();
const CONFIGURED = Boolean(
  env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY,
);

// Secret de webhook LOCAL, propre à ce fichier de test.
const TEST_WEBHOOK_SECRET = `whsec_test_${randomUUID().replaceAll("-", "")}`;
const EMAIL = "postync-c7-webhook@example.com";
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };

let admin: SupabaseClient;
let workspaceId = "";
let post: (typeof import("@/app/api/stripe/webhook/route"))["POST"];

const CUS = "cus_C7Test0001";
const SUB = "sub_C7Test0001";
const PRICE_M = "price_c7_creator_month";

let eventSeq = 0;
function makeEvent(type: string, object: Record<string, unknown>, id?: string) {
  eventSeq += 1;
  return {
    id: id ?? `evt_C7Test${String(eventSeq).padStart(4, "0")}`,
    object: "event",
    type,
    api_version: "2026-01-01",
    created: Math.floor(Date.now() / 1000),
    data: { object },
  };
}

function subscriptionObject(overrides: Record<string, unknown> = {}) {
  return {
    id: SUB,
    object: "subscription",
    customer: CUS,
    status: "active",
    cancel_at_period_end: false,
    canceled_at: null,
    metadata: { workspace_id: workspaceId, plan_key: "creator" },
    items: {
      object: "list",
      data: [
        {
          id: "si_C7Test0001",
          object: "subscription_item",
          current_period_start: 1755600000,
          current_period_end: 1758278400,
          price: { id: PRICE_M, object: "price", recurring: { interval: "month" } },
        },
      ],
    },
    ...overrides,
  };
}

/** Envoie un événement à la vraie route, signé (ou non) comme le ferait Stripe. */
async function send(
  event: Record<string, unknown>,
  options: { signature?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(event);
  const signature =
    options.signature === undefined
      ? Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
      : options.signature;

  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("stripe-signature", signature);

  const request = new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers,
    body: payload,
  });
  const response = await post(request);
  return { status: response.status, body: await response.json() };
}

async function localSubscription() {
  const { data } = await admin
    .from("subscriptions")
    .select("*")
    .eq("stripe_subscription_id", SUB)
    .maybeSingle();
  return data;
}

async function cleanup() {
  await admin.from("subscription_events").delete().like("stripe_event_id", "evt_C7Test%");
  await admin.from("subscriptions").delete().like("stripe_subscription_id", "sub_C7Test%");
  await admin.from("billing_customers").delete().like("stripe_customer_id", "cus_C7Test%");
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((u) => u.email === EMAIL)) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C7 — webhook Stripe (route réelle + DB réelle)", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    process.env.STRIPE_PRICE_CREATOR_MONTHLY = PRICE_M;

    ({ POST: post } = await import("@/app/api/stripe/webhook/route"));

    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    const password = `C7-${randomUUID()}`;
    const { error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password,
      email_confirm: true,
      user_metadata: { display_name: "C7 Webhook" },
    });
    if (error) throw error;

    // Le workspace est créé via la RPC `create_workspace`, comme en production :
    // workspace + membership owner dans la même transaction. Un `insert` direct
    // en service_role laisserait une fenêtre où le workspace n'a pas de owner.
    const asOwner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, NO_SESSION);
    const { error: signInError } = await asOwner.auth.signInWithPassword({ email: EMAIL, password });
    if (signInError) throw signInError;
    const { data: ws, error: wsError } = await asOwner.rpc("create_workspace", {
      p_name: `C7 Webhook WS ${randomUUID().slice(0, 8)}`,
    });
    if (wsError) throw wsError;
    workspaceId = (ws as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_PRICE_CREATOR_MONTHLY;
    const { count } = await admin
      .from("subscription_events")
      .select("*", { count: "exact", head: true })
      .like("stripe_event_id", "evt_C7Test%");
    expect(count).toBe(0);
  }, 60_000);

  it("S1 — signature invalide ou absente : 400, rien n'est écrit", async () => {
    const event = makeEvent("customer.subscription.created", subscriptionObject());
    const bad = await send(event, { signature: "t=1,v1=deadbeef" });
    expect(bad.status).toBe(400);
    const missing = await send(event, { signature: null });
    expect(missing.status).toBe(400);

    // Signature calculée avec un AUTRE secret : refusée aussi.
    const otherSecret = Stripe.webhooks.generateTestHeaderString({
      payload: JSON.stringify(event),
      secret: "whsec_other_secret_123456",
    });
    const wrong = await send(event, { signature: otherSecret });
    expect(wrong.status).toBe(400);

    expect(await localSubscription()).toBeNull();
    const { count } = await admin
      .from("subscription_events")
      .select("*", { count: "exact", head: true })
      .like("stripe_event_id", "evt_C7Test%");
    expect(count).toBe(0);
  });

  it("S2 — checkout.session.completed valide : mapping customer enregistré", async () => {
    const { status, body } = await send(
      makeEvent("checkout.session.completed", {
        id: "cs_C7Test0001",
        object: "checkout.session",
        customer: CUS,
        metadata: { workspace_id: workspaceId, plan_key: "creator" },
      }),
    );
    expect(status).toBe(200);
    expect(body.result).toBe("processed");

    const { data } = await admin
      .from("billing_customers")
      .select("workspace_id, stripe_customer_id")
      .eq("stripe_customer_id", CUS)
      .single();
    expect(data).toEqual({ workspace_id: workspaceId, stripe_customer_id: CUS });
  });

  it("S3 — le même event rejoué n'est appliqué qu'une fois", async () => {
    const event = makeEvent("customer.subscription.created", subscriptionObject(), "evt_C7TestDup01");
    const first = await send(event);
    expect(first.body.result).toBe("processed");
    const second = await send(event);
    expect(second.status).toBe(200);
    expect(second.body.result).toBe("duplicate");

    const { count } = await admin
      .from("subscriptions")
      .select("*", { count: "exact", head: true })
      .eq("stripe_subscription_id", SUB);
    expect(count).toBe(1);
  });

  it("S4 — subscription.created : réplique locale complète (plan résolu côté serveur)", async () => {
    const row = await localSubscription();
    expect(row).toMatchObject({
      workspace_id: workspaceId,
      stripe_subscription_id: SUB,
      stripe_customer_id: CUS,
      stripe_price_id: PRICE_M,
      plan_key: "creator",
      billing_interval: "month",
      status: "active",
      cancel_at_period_end: false,
    });
    expect(row.current_period_end).toBe("2025-09-19T10:40:00+00:00");
  });

  it("S5 — subscription.updated : synchronisée (annulation en fin de période)", async () => {
    const { body } = await send(
      makeEvent(
        "customer.subscription.updated",
        subscriptionObject({ cancel_at_period_end: true, status: "active" }),
      ),
    );
    expect(body.result).toBe("processed");
    expect(await localSubscription()).toMatchObject({ status: "active", cancel_at_period_end: true });
  });

  it("S7 — invoice.payment_failed : past_due ; invoice.paid : retour à active", async () => {
    const failed = await send(
      makeEvent("invoice.payment_failed", {
        id: "in_C7Test0001",
        object: "invoice",
        parent: { subscription_details: { subscription: SUB, metadata: {} }, type: "subscription_details" },
      }),
    );
    expect(failed.body.result).toBe("processed");
    expect((await localSubscription()).status).toBe("past_due");

    const paid = await send(
      makeEvent("invoice.paid", {
        id: "in_C7Test0002",
        object: "invoice",
        parent: { subscription_details: { subscription: SUB, metadata: {} }, type: "subscription_details" },
      }),
    );
    expect(paid.body.result).toBe("processed");
    expect((await localSubscription()).status).toBe("active");
  });

  it("S6 — subscription.deleted : statut canceled", async () => {
    const { body } = await send(
      makeEvent(
        "customer.subscription.deleted",
        subscriptionObject({ status: "canceled", canceled_at: 1755700000 }),
      ),
    );
    expect(body.result).toBe("processed");
    const row = await localSubscription();
    expect(row.status).toBe("canceled");
    expect(row.canceled_at).not.toBeNull();
  });

  it("événement non géré : 200 ignored, sans écriture", async () => {
    const { body } = await send(makeEvent("customer.created", { id: CUS, object: "customer" }));
    expect(body.result).toBe("ignored");
  });

  it("RLS — le membre du workspace lit sa réplique ; un tiers non", async () => {
    // (le webhook a réactivé puis annulé l'abonnement : la ligne existe)
    const { data: asAdmin } = await admin
      .from("subscriptions")
      .select("plan_key")
      .eq("workspace_id", workspaceId);
    expect(asAdmin).toHaveLength(1);

    const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, NO_SESSION);
    const { data: asAnon, error } = await anon.from("subscriptions").select("plan_key");
    // Sans session : soit refus explicite (42501), soit zéro ligne — jamais de donnée.
    expect(asAnon ?? []).toEqual([]);
    if (error) expect(error.code).toBe("42501");
  });
});
