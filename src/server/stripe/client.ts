import "server-only";

import Stripe from "stripe";

/**
 * Instance Stripe serveur unique (SDK officiel), créée à la demande.
 * Jamais importée par un composant client (`server-only`).
 */
let instance: Stripe | null = null;

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY manquante : Stripe n'est pas configuré.");
  }
  if (!instance) {
    instance = new Stripe(key, {
      appInfo: { name: "POSTYNC", url: "https://github.com/Kodeho/postync" },
    });
  }
  return instance;
}
