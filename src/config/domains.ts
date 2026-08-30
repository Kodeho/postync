/**
 * Les deux domaines publics de POSTYNC — source unique de vérité.
 *
 * L'architecture retenue le 2026-08-30 sépare deux surfaces qui n'ont ni le
 * même public ni les mêmes contraintes :
 *
 *   - `postync.app`     — site public : présentation, tarifs, documents
 *                         légaux. Aucune authentification, aucune donnée
 *                         personnelle. C'est l'adresse déclarée à Meta,
 *                         TikTok et Google, et celle qu'un auditeur ouvre.
 *   - `app.postync.app` — l'application. Sessions, jetons sociaux, quotas.
 *
 * ATTENTION — ceci n'est PAS l'origine des `redirect_uri` OAuth ni des liens
 * d'authentification. Ceux-là viennent de `getSiteOrigin()`, qui lit
 * `NEXT_PUBLIC_SITE_URL`, et doivent rester sur `app.postync.app`. Confondre
 * les deux casserait les quatre intégrations sociales d'un coup.
 */

/** Hôte du site public. */
export const PUBLIC_HOST = "postync.app";
/** Hôte de l'application. */
export const APP_HOST = "app.postync.app";

export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
export const APP_ORIGIN = `https://${APP_HOST}`;

/**
 * Les seuls chemins servis par le site public.
 *
 * Liste EXHAUSTIVE et non préfixe : tout le reste appartient à
 * l'application. Une liste de préfixes laisserait passer `/legalxyz` ou, plus
 * grave, ferait servir `/login` par le domaine public si un jour une route
 * commençait par le même segment.
 */
export const PUBLIC_PATHS: readonly string[] = ["/", "/legal", "/terms", "/privacy"];

/** Documents légaux, dont l'URL canonique est le domaine public. */
export const LEGAL_PATHS: readonly string[] = ["/legal", "/terms", "/privacy"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(normalize(pathname));
}

export function isLegalPath(pathname: string): boolean {
  return LEGAL_PATHS.includes(normalize(pathname));
}

/**
 * `/privacy/` et `/privacy` désignent la même page : sans cette
 * normalisation, une barre finale suffirait à contourner la séparation.
 */
function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}
