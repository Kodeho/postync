"use server";

import { redirect } from "next/navigation";

import { getSiteOrigin } from "@/lib/site-url";
import { getPlan } from "@/config/plans";
import { listMemberships, requireUser } from "@/features/workspaces/queries";
import { findMembershipBySlug } from "@/features/workspaces/resolve";
import { createServiceClient } from "@/server/supabase/service-client";
import type { WorkspaceMembership } from "@/types/workspace";

import type { BillingActionState } from "./action-state";
import { getStripe } from "./client";
import {
  isBillingInterval,
  isPaidPlanKey,
  isStripeConfigured,
  priceIdFor,
} from "./config";

/**
 * Server Actions de facturation.
 *
 * Chaîne de sécurité, identique pour checkout et portail :
 *   1. session revalidée + compte actif (`requireUser`) ;
 *   2. workspace résolu par SLUG contre les memberships réelles sous RLS —
 *      jamais un workspace_id libre du navigateur ;
 *   3. seul un `owner` ou `admin` du workspace gère la facturation ;
 *   4. le navigateur n'envoie qu'un couple (plan, intervalle) : le Price ID
 *      est résolu côté serveur depuis l'environnement, jamais accepté du
 *      client ;
 *   5. les URLs success/cancel/return sont construites par le serveur depuis
 *      l'origine du site — aucune URL arbitraire acceptée.
 */

const NOT_CONFIGURED =
  "La facturation n'est pas encore configurée sur cette installation.";
const NOT_ALLOWED =
  "Seul le propriétaire ou un admin du workspace peut gérer l'abonnement.";

function canManageBilling(membership: WorkspaceMembership): boolean {
  return membership.role === "owner" || membership.role === "admin";
}

/** Résout le workspace du slug soumis et vérifie le droit de facturation. */
async function requireBillingManager(formData: FormData): Promise<
  | { ok: true; membership: WorkspaceMembership }
  | { ok: false; error: string }
> {
  const slug = String(formData.get("workspaceSlug") ?? "");
  const { supabase, user } = await requireUser();
  const memberships = await listMemberships(supabase, user.id);
  const membership = findMembershipBySlug(memberships, slug);
  if (!membership) {
    // Slug inconnu ou étranger : indiscernables, comme partout ailleurs.
    return { ok: false, error: "Workspace introuvable." };
  }
  if (!canManageBilling(membership)) {
    return { ok: false, error: NOT_ALLOWED };
  }
  return { ok: true, membership };
}

/** Customer Stripe du workspace : réutilisé s'il existe, créé sinon. */
async function getOrCreateStripeCustomer(workspaceId: string, workspaceName: string): Promise<string> {
  const db = createServiceClient();
  const { data: existing } = await db
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (existing?.stripe_customer_id) {
    return existing.stripe_customer_id;
  }

  const customer = await getStripe().customers.create({
    name: workspaceName,
    metadata: { workspace_id: workspaceId },
  });

  // `onConflict: workspace_id` : si deux checkouts simultanés créent chacun un
  // customer, un seul mapping survit et sera systématiquement réutilisé.
  const { error } = await db
    .from("billing_customers")
    .upsert(
      { workspace_id: workspaceId, stripe_customer_id: customer.id },
      { onConflict: "workspace_id" },
    );
  if (error) {
    throw new Error(`billing_customers: ${error.message}`);
  }
  const { data: final } = await db
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("workspace_id", workspaceId)
    .single();
  return final?.stripe_customer_id ?? customer.id;
}

/**
 * Lance Stripe Checkout pour un couple (plan, intervalle).
 * Le webhook reste la seule source d'activation de l'abonnement.
 */
export async function startCheckoutAction(
  _prev: BillingActionState,
  formData: FormData,
): Promise<BillingActionState> {
  const auth = await requireBillingManager(formData);
  if (!auth.ok) {
    return { error: auth.error };
  }
  if (!isStripeConfigured()) {
    return { error: NOT_CONFIGURED };
  }

  const planRaw = String(formData.get("plan") ?? "");
  const intervalRaw = String(formData.get("interval") ?? "");
  if (!isPaidPlanKey(planRaw) || !isBillingInterval(intervalRaw)) {
    return { error: "Offre invalide." };
  }

  const priceId = priceIdFor(planRaw, intervalRaw);
  if (!priceId) {
    return { error: `L'offre ${getPlan(planRaw).name} n'est pas encore disponible.` };
  }

  const { workspace } = auth.membership;
  let url: string | null;
  try {
    const customerId = await getOrCreateStripeCustomer(workspace.id, workspace.name);
    const origin = await getSiteOrigin();
    const base = `${origin}/app/${workspace.slug}/billing`;

    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/success`,
      cancel_url: `${base}/cancel`,
      metadata: { workspace_id: workspace.id, plan_key: planRaw },
      subscription_data: {
        metadata: { workspace_id: workspace.id, plan_key: planRaw },
      },
    });
    url = session.url;
  } catch (error) {
    console.error(
      `[billing:checkout] ${error instanceof Error ? error.message : "erreur inconnue"}`,
    );
    return { error: "Impossible de démarrer le paiement. Veuillez réessayer." };
  }

  if (!url) {
    return { error: "Impossible de démarrer le paiement. Veuillez réessayer." };
  }
  redirect(url);
}

/** Ouvre le Stripe Billing Portal (factures, carte, annulation). */
export async function openBillingPortalAction(
  _prev: BillingActionState,
  formData: FormData,
): Promise<BillingActionState> {
  const auth = await requireBillingManager(formData);
  if (!auth.ok) {
    return { error: auth.error };
  }
  if (!isStripeConfigured()) {
    return { error: NOT_CONFIGURED };
  }

  const { workspace } = auth.membership;
  const db = createServiceClient();
  const { data: customer } = await db
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (!customer?.stripe_customer_id) {
    return { error: "Aucun abonnement à gérer pour ce workspace." };
  }

  let url: string;
  try {
    const origin = await getSiteOrigin();
    const session = await getStripe().billingPortal.sessions.create({
      customer: customer.stripe_customer_id,
      return_url: `${origin}/app/${workspace.slug}/billing`,
    });
    url = session.url;
  } catch (error) {
    console.error(
      `[billing:portal] ${error instanceof Error ? error.message : "erreur inconnue"}`,
    );
    return { error: "Impossible d'ouvrir le portail de facturation." };
  }
  redirect(url);
}
