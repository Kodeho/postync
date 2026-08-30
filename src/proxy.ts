import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  APP_HOST,
  APP_ORIGIN,
  PUBLIC_HOST,
  PUBLIC_ORIGIN,
  isLegalPath,
  isPublicPath,
} from "@/config/domains";

/**
 * Séparation du site public et de l'application (C18).
 *
 * Les deux domaines sont servis par le MÊME projet Vercel : sans arbitrage,
 * `postync.app/app/...` et `app.postync.app/privacy` répondraient tous les
 * deux. Deux URL pour une même page, c'est une adresse ambiguë pour les
 * auditeurs des plateformes et une session posée sur le mauvais domaine pour
 * l'utilisateur.
 *
 * Deux règles, et rien de plus :
 *
 *   1. le domaine public ne sert QUE les pages publiques ; tout le reste part
 *      vers l'application, chemin et paramètres conservés ;
 *   2. les documents légaux n'ont qu'une adresse canonique, le domaine public.
 *
 * Redirection 308 (et non 307) : elle est permanente et interdit au client de
 * transformer la méthode. Un POST redirigé reste un POST.
 *
 * CE QUI N'EST PAS TOUCHÉ, et ne doit jamais l'être : les `redirect_uri`
 * OAuth. Ils vivent sur `app.postync.app` et sont construits par
 * `getSiteOrigin()` depuis `NEXT_PUBLIC_SITE_URL`. Le proxy ne réécrit jamais
 * `/api/oauth/...` sur le domaine de l'application — la règle 2 ne vise que
 * trois chemins légaux, nommément.
 *
 * Fichier `proxy.ts` et non `middleware.ts` : le second est déprécié depuis
 * Next.js 16, qui l'a renommé.
 */

/** Hôte réel de la requête, port et casse écartés. */
function hostOf(request: NextRequest): string {
  const brut = request.headers.get("host") ?? request.nextUrl.host;
  return brut.split(":")[0].toLowerCase();
}

function versAutreDomaine(request: NextRequest, origine: string): NextResponse {
  const cible = new URL(request.nextUrl.pathname + request.nextUrl.search, origine);
  return NextResponse.redirect(cible, 308);
}

export function proxy(request: NextRequest): NextResponse {
  const host = hostOf(request);
  const { pathname } = request.nextUrl;

  if (host === PUBLIC_HOST && !isPublicPath(pathname)) {
    return versAutreDomaine(request, APP_ORIGIN);
  }

  if (host === APP_HOST && isLegalPath(pathname)) {
    return versAutreDomaine(request, PUBLIC_ORIGIN);
  }

  // Tout autre hôte — `localhost`, une prévisualisation Vercel — traverse sans
  // règle. Rediriger depuis une preview enverrait le testeur sur la
  // production, c'est-à-dire précisément là où il ne veut pas vérifier.
  return NextResponse.next();
}

export const config = {
  /*
   * Les ressources statiques sont exclues : sans cela, une feuille de style
   * demandée à l'apex partirait en redirection et la page s'afficherait nue.
   * `_next/static`, `_next/image` et les fichiers de `public/` (reconnus à
   * leur extension) restent servis par l'hôte qui les a demandés.
   */
  matcher: ["/((?!_next/static|_next/image|.*\\.[\\w]+$).*)"],
};
