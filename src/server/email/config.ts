import "server-only";

import { PRODUCT_NAME } from "@/config/product";

/**
 * Configuration de l'envoi de courriels (Scaleway TEM).
 *
 * TOUT EST ICI, ET RIEN AILLEURS. L'adresse d'expédition, le nom affiché et
 * l'adresse de réponse sont lus dans l'environnement : le jour où le domaine
 * définitif sera authentifié, il se renseigne sans qu'une ligne de code change.
 * Aucun de ces éléments n'est écrit en dur dans un modèle de message.
 *
 * `server-only` n'est pas décoratif : ce module lit la clé secrète Scaleway.
 * L'importer depuis un composant client ferait échouer le build — ce qui est
 * exactement la protection recherchée, une clé d'envoi valant droit d'écrire
 * au nom de POSTYNC à qui la détient.
 */

/** Région Scaleway. `fr-par` est le seul choix pour TEM, et c'est voulu. */
const DEFAULT_REGION = "fr-par";

export type EmailConfig = {
  apiKey: string;
  projectId: string;
  region: string;
  from: { email: string; name: string };
  /** Adresse à laquelle une réponse doit arriver, souvent différente. */
  replyTo: string | null;
};

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * L'envoi est-il configuré ?
 *
 * Tant que le domaine n'est pas authentifié chez Scaleway, ces variables
 * restent vides et POSTYNC se rabat sur le lien à copier. Cette fonction est
 * donc le commutateur entre les deux comportements — et non un drapeau
 * séparé qu'il faudrait penser à basculer.
 */
export function isEmailConfigured(): boolean {
  return (
    env("SCW_SECRET_KEY").length > 0 &&
    env("SCW_PROJECT_ID").length > 0 &&
    env("EMAIL_FROM_ADDRESS").length > 0
  );
}

/**
 * Configuration résolue, ou `null` si l'envoi n'est pas configuré.
 *
 * Ne lève pas : un envoi non configuré n'est pas une panne, c'est l'état
 * normal du produit tant que le domaine n'existe pas. C'est à l'appelant de
 * décider quoi faire — pour les invitations, afficher le lien.
 */
export function getEmailConfig(): EmailConfig | null {
  if (!isEmailConfigured()) {
    return null;
  }

  const fromEmail = env("EMAIL_FROM_ADDRESS");
  const replyTo = env("EMAIL_REPLY_TO");

  return {
    apiKey: env("SCW_SECRET_KEY"),
    projectId: env("SCW_PROJECT_ID"),
    region: env("SCW_TEM_REGION") || DEFAULT_REGION,
    from: {
      email: fromEmail,
      name: env("EMAIL_FROM_NAME") || PRODUCT_NAME,
    },
    replyTo: replyTo.length > 0 ? replyTo : null,
  };
}

/**
 * Origine publique utilisée dans les liens des courriels.
 *
 * Distincte de `getSiteOrigin()` : celle-là déduit l'origine des en-têtes de
 * la requête, ce qui n'a aucun sens pour un message envoyé depuis une tâche de
 * fond, où il n'y a pas de requête. Un lien de courriel doit toujours pointer
 * vers l'adresse publique, jamais vers un hôte de prévisualisation Vercel.
 */
export function getEmailSiteOrigin(): string {
  const configured = env("NEXT_PUBLIC_SITE_URL");
  return configured.length > 0
    ? configured.replace(/\/$/, "")
    : "https://postync.vercel.app";
}
