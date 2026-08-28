import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * État des intégrations, pour /admin/platform.
 *
 * Ne renvoie que des booléens « configuré / non configuré » calculés côté
 * serveur à partir de la PRÉSENCE des variables d'environnement. Aucune
 * valeur, aucun fragment de clé ne sort de ce module.
 */

export type IntegrationStatus = {
  key: string;
  label: string;
  configured: boolean;
  note: string;
};

function present(...names: string[]): boolean {
  return names.every((name) => (process.env[name] ?? "").length > 0);
}

export function getIntegrationStatuses(): IntegrationStatus[] {
  return [
    {
      key: "supabase",
      label: "Supabase",
      configured: isSupabaseConfigured(),
      note: "Authentification, base de données, RLS.",
    },
    {
      key: "stripe",
      label: "Stripe",
      configured: present("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"),
      note: "Checkout, webhook et Billing Portal (clé secrète + secret webhook).",
    },
    {
      key: "meta",
      label: "Meta (Instagram, Facebook)",
      configured: present("META_CLIENT_ID", "META_CLIENT_SECRET"),
      note: "Connexion des comptes — étape ultérieure.",
    },
    {
      key: "tiktok",
      label: "TikTok",
      configured: present("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"),
      note: "Connexion des comptes — étape ultérieure.",
    },
    {
      key: "youtube",
      label: "YouTube (Google)",
      configured: present("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
      note: "Connexion des comptes — étape ultérieure.",
    },
    // Deux lignes plutôt qu'une, parce que les deux moitiés s'obtiennent à des
    // moments différents : les identifiants Scaleway dès la création de la clé,
    // l'adresse d'expédition seulement une fois le domaine authentifié. Les
    // fondre masquerait laquelle des deux manque.
    {
      key: "scaleway",
      label: "Scaleway (accès)",
      configured: present("SCW_SECRET_KEY", "SCW_PROJECT_ID"),
      note: "Clé API et projet Transactional Email.",
    },
    {
      key: "email",
      label: "Envoi de courriels",
      configured: present("SCW_SECRET_KEY", "SCW_PROJECT_ID", "EMAIL_FROM_ADDRESS"),
      note:
        "Actif seulement avec une adresse d'expédition sur un domaine authentifié. " +
        "Tant qu'il manque, les invitations affichent un lien à copier.",
    },
  ];
}

export function getEnvironmentLabel(): string {
  const vercel = process.env.VERCEL_ENV;
  if (vercel) return vercel;
  return process.env.NODE_ENV ?? "development";
}
