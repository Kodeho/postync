import { NextResponse } from "next/server";
import Stripe from "stripe";

import { createServiceClient } from "@/server/supabase/service-client";
import { handleStripeEvent } from "@/server/stripe/webhook";

/**
 * Webhook Stripe — `POST /api/stripe/webhook`.
 *
 * 1. lit le RAW body (indispensable à la vérification de signature) ;
 * 2. vérifie la signature `stripe-signature` avec STRIPE_WEBHOOK_SECRET ;
 * 3. refuse toute signature invalide (400) ;
 * 4. traite l'événement de façon idempotente (`subscription_events`).
 *
 * Cette route est appelée par Stripe, sans session utilisateur : c'est la
 * signature qui fait office d'authentification. Les écritures utilisent le
 * client service_role, strictement côté serveur.
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!secret) {
    console.error("[stripe:webhook] STRIPE_WEBHOOK_SECRET manquante");
    return NextResponse.json({ error: "webhook non configuré" }, { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "signature absente" }, { status: 400 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    // Vérification statique : aucune clé API requise, seulement le secret.
    event = await Stripe.webhooks.constructEventAsync(rawBody, signature, secret);
  } catch (error) {
    console.error(
      `[stripe:webhook] signature invalide: ${error instanceof Error ? error.name : "erreur"}`,
    );
    return NextResponse.json({ error: "signature invalide" }, { status: 400 });
  }

  const outcome = await handleStripeEvent(createServiceClient(), event);

  if (!outcome.ok) {
    // 500 => Stripe rejouera l'événement (le verrou d'idempotence a été retiré).
    return NextResponse.json({ error: "traitement échoué" }, { status: 500 });
  }

  return NextResponse.json({ received: true, result: outcome.result });
}
