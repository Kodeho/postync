import { headers } from "next/headers";

/**
 * Détermine l'origine publique de l'application.
 *
 * Utilisée pour construire le lien de confirmation d'e-mail envoyé par
 * Supabase. `NEXT_PUBLIC_SITE_URL` prend le pas lorsqu'elle est définie
 * (déploiement derrière un proxy ou domaine personnalisé) ; sinon l'origine
 * est déduite des en-têtes de la requête.
 */
export async function getSiteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured && configured.length > 0) {
    return configured.replace(/\/$/, "");
  }

  const headerList = await headers();
  const forwardedHost = headerList.get("x-forwarded-host");
  const host = forwardedHost ?? headerList.get("host") ?? "localhost:3000";
  const protocol =
    headerList.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");

  return `${protocol}://${host}`;
}
