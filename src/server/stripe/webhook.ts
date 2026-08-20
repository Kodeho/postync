import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

import { planFromPriceId } from "./config";

/**
 * Traitement des webhooks Stripe.
 *
 * Contrat :
 *   * le RAW BODY est vérifié contre la signature `stripe-signature` avec
 *     STRIPE_WEBHOOK_SECRET — toute signature invalide est refusée en 400 ;
 *   * idempotence : `subscription_events.stripe_event_id` est unique ; un
 *     événement déjà traité est ignoré (200, `duplicate`) ;
 *   * Stripe est la source de vérité : ces handlers ne font que synchroniser
 *     la réplique locale (`billing_customers`, `subscriptions`) ;
 *   * `payload_metadata` ne garde que des identifiants et statuts — jamais le
 *     payload complet, jamais de donnée de carte ou de client.
 *
 * Le client Supabase reçu ici est le client service_role (écritures serveur).
 */

export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

export type HandledEventType = (typeof HANDLED_EVENTS)[number];

export type WebhookOutcome =
  | { ok: true; result: "processed" | "duplicate" | "ignored" }
  | { ok: false; error: string };

function first<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function toIso(epochSeconds: number | null | undefined): string | null {
  return typeof epochSeconds === "number" ? new Date(epochSeconds * 1000).toISOString() : null;
}

/** Extrait de l'abonnement Stripe les champs de la réplique locale. */
export function mapSubscription(sub: Stripe.Subscription): {
  stripe_subscription_id: string;
  stripe_customer_id: string;
  stripe_price_id: string;
  plan_key: string;
  billing_interval: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  workspace_id_hint: string | null;
} {
  const item = first(sub.items?.data);
  const priceId = item?.price?.id ?? "";
  const resolved = priceId ? planFromPriceId(priceId) : null;
  // Repli sur l'intervalle du Price Stripe si le Price ID n'est pas dans la
  // configuration (plan inconnu, jamais bloquant).
  const stripeInterval = item?.price?.recurring?.interval;

  return {
    stripe_subscription_id: sub.id,
    stripe_customer_id: idOf(sub.customer) ?? "",
    stripe_price_id: priceId,
    plan_key: resolved?.planKey ?? "unknown",
    billing_interval:
      resolved?.interval ?? (stripeInterval === "month" || stripeInterval === "year" ? stripeInterval : "unknown"),
    status: sub.status,
    current_period_start: toIso(item?.current_period_start),
    current_period_end: toIso(item?.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    canceled_at: toIso(sub.canceled_at),
    workspace_id_hint: sub.metadata?.workspace_id ?? null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** workspace_id d'un abonnement : metadata, sinon mapping billing_customers. */
async function resolveWorkspaceId(
  db: SupabaseClient,
  hint: string | null,
  stripeCustomerId: string,
): Promise<string | null> {
  if (hint && UUID.test(hint)) {
    return hint;
  }
  const { data } = await db
    .from("billing_customers")
    .select("workspace_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  return data?.workspace_id ?? null;
}

async function upsertCustomerMapping(
  db: SupabaseClient,
  workspaceId: string,
  stripeCustomerId: string,
): Promise<void> {
  const { error } = await db
    .from("billing_customers")
    .upsert(
      { workspace_id: workspaceId, stripe_customer_id: stripeCustomerId },
      { onConflict: "workspace_id" },
    );
  if (error) {
    throw new Error(`billing_customers upsert: ${error.message}`);
  }
}

async function syncSubscription(db: SupabaseClient, sub: Stripe.Subscription): Promise<void> {
  const mapped = mapSubscription(sub);
  const workspaceId = await resolveWorkspaceId(db, mapped.workspace_id_hint, mapped.stripe_customer_id);
  if (!workspaceId) {
    // Abonnement d'un customer inconnu de POSTYNC : journalisé, sans écriture.
    console.error(`[stripe:webhook] workspace introuvable pour ${mapped.stripe_subscription_id}`);
    return;
  }
  // Garantit le mapping customer même si checkout.session.completed s'est perdu.
  await upsertCustomerMapping(db, workspaceId, mapped.stripe_customer_id);

  const row = { ...mapped, workspace_id_hint: undefined };
  delete row.workspace_id_hint;
  const { error } = await db
    .from("subscriptions")
    .upsert({ ...row, workspace_id: workspaceId }, { onConflict: "stripe_subscription_id" });
  if (error) {
    throw new Error(`subscriptions upsert: ${error.message}`);
  }
}

/** Ajuste le statut local d'un abonnement à partir d'un événement de facture. */
async function applyInvoiceStatus(
  db: SupabaseClient,
  invoice: Stripe.Invoice,
  kind: "paid" | "failed",
): Promise<void> {
  const raw = invoice.parent?.subscription_details?.subscription ?? null;
  const subId = idOf(raw);
  if (!subId) return;

  if (kind === "failed") {
    // Politique V1 : l'échec bancaire passe l'abonnement en past_due (accès
    // conservé avec avertissement) — customer.subscription.updated arrivera
    // aussi de Stripe et confirmera l'état.
    const { error } = await db
      .from("subscriptions")
      .update({ status: "past_due" })
      .eq("stripe_subscription_id", subId)
      .in("status", ["active", "trialing", "past_due"]);
    if (error) throw new Error(`invoice.payment_failed: ${error.message}`);
    return;
  }

  // Facture payée : si la réplique locale était en retard, elle redevient active.
  const { error } = await db
    .from("subscriptions")
    .update({ status: "active" })
    .eq("stripe_subscription_id", subId)
    .in("status", ["past_due", "unpaid", "incomplete"]);
  if (error) throw new Error(`invoice.paid: ${error.message}`);
}

/** Metadata non sensibles conservées pour le diagnostic. */
function eventMetadata(event: Stripe.Event): Record<string, unknown> {
  const object = event.data.object as unknown as Record<string, unknown>;
  return {
    object_id: typeof object.id === "string" ? object.id : null,
    object_type: typeof object.object === "string" ? object.object : null,
    status: typeof object.status === "string" ? object.status : null,
  };
}

/**
 * Traite un événement Stripe VÉRIFIÉ, de façon idempotente.
 * L'insertion dans `subscription_events` sert de verrou : si l'id existe déjà,
 * l'événement a déjà été appliqué et rien n'est refait.
 */
export async function handleStripeEvent(
  db: SupabaseClient,
  event: Stripe.Event,
): Promise<WebhookOutcome> {
  if (!(HANDLED_EVENTS as readonly string[]).includes(event.type)) {
    return { ok: true, result: "ignored" };
  }

  // Idempotence : tentative d'insertion ; conflit = déjà traité.
  const { error: insertError } = await db.from("subscription_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    payload_metadata: eventMetadata(event),
  });
  if (insertError) {
    if (insertError.code === "23505") {
      return { ok: true, result: "duplicate" };
    }
    return { ok: false, error: `subscription_events: ${insertError.message}` };
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const workspaceId = session.metadata?.workspace_id ?? null;
        const customerId = idOf(session.customer as string | { id: string } | null);
        if (workspaceId && UUID.test(workspaceId) && customerId) {
          await upsertCustomerMapping(db, workspaceId, customerId);
        }
        // L'abonnement lui-même est synchronisé par customer.subscription.*.
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // `deleted` livre l'abonnement final avec status = canceled.
        await syncSubscription(db, event.data.object as Stripe.Subscription);
        break;
      }
      case "invoice.paid": {
        await applyInvoiceStatus(db, event.data.object as Stripe.Invoice, "paid");
        break;
      }
      case "invoice.payment_failed": {
        await applyInvoiceStatus(db, event.data.object as Stripe.Invoice, "failed");
        break;
      }
    }
    return { ok: true, result: "processed" };
  } catch (error) {
    // Échec de traitement : on retire le verrou pour que le retry Stripe
    // puisse rejouer l'événement.
    await db.from("subscription_events").delete().eq("stripe_event_id", event.id);
    const message = error instanceof Error ? error.message : "erreur inconnue";
    console.error(`[stripe:webhook] ${event.type} ${event.id}: ${message}`);
    return { ok: false, error: message };
  }
}
