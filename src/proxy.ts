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
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Point d'entrée Proxy de Next.js 16.
 *
 * ATTENTION : la convention `middleware.ts` est dépréciée depuis Next.js 16 et
 * renommée `proxy.ts` (voir
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`).
 * Le fichier doit se trouver au même niveau que `app/`, donc dans `src/`.
 *
 * Proxy s'exécute sur le runtime Node.js par défaut en v16, ce qui permet
 * d'utiliser `@supabase/ssr` sans restriction Edge.
 *
 * Deux responsabilités, dans cet ordre :
 *
 *   1. l'arbitrage entre les deux domaines (C18) ;
 *   2. le rafraîchissement de la session Supabase et les redirections d'accès.
 *
 * L'ordre n'est pas indifférent. Une requête qui part vers l'autre domaine n'a
 * pas besoin qu'on revalide son jeton auprès de Supabase : ce serait un
 * aller-retour réseau pour une réponse qui ne sert aucune page. Le
 * rafraîchissement aura lieu sur la requête suivante, à destination.
 */

/**
 * Séparation du site public et de l'application (C18).
 *
 * Les deux domaines sont servis par le MÊME projet Vercel : sans arbitrage,
 * `postync.app/app/...` et `app.postync.app/privacy` répondraient tous les
 * deux. Deux URL pour une même page, c'est une adresse ambiguë pour les
 * auditeurs des plateformes et une session posée sur le mauvais domaine.
 *
 * Deux règles, et rien de plus :
 *
 *   1. le domaine public ne sert QUE les pages publiques ; tout le reste part
 *      vers l'application, chemin et paramètres conservés ;
 *   2. les documents légaux n'ont qu'une adresse canonique, le domaine public.
 *
 * Redirection 308 (et non 307) : permanente, et elle interdit au client de
 * transformer la méthode — un POST redirigé reste un POST.
 *
 * CE QUI N'EST PAS TOUCHÉ, et ne doit jamais l'être : les `redirect_uri`
 * OAuth. Ils vivent sur `app.postync.app` et sont construits par
 * `getSiteOrigin()` depuis `NEXT_PUBLIC_SITE_URL`. La règle 2 ne vise que
 * trois chemins légaux, nommément désignés : `/api/oauth/...` n'est jamais
 * réécrit sur le domaine de l'application.
 */
function arbitrerDomaine(request: NextRequest): NextResponse | null {
  const host = (request.headers.get("host") ?? request.nextUrl.host)
    .split(":")[0]
    .toLowerCase();
  const { pathname } = request.nextUrl;

  if (host === PUBLIC_HOST && !isPublicPath(pathname)) {
    return versDomaine(request, APP_ORIGIN);
  }

  if (host === APP_HOST && isLegalPath(pathname)) {
    return versDomaine(request, PUBLIC_ORIGIN);
  }

  // Tout autre hôte — `localhost`, une prévisualisation Vercel — traverse sans
  // règle. Rediriger depuis une preview enverrait le testeur sur la
  // production, c'est-à-dire précisément là où il ne veut pas vérifier.
  return null;
}

function versDomaine(request: NextRequest, origine: string): NextResponse {
  const cible = new URL(request.nextUrl.pathname + request.nextUrl.search, origine);
  return NextResponse.redirect(cible, 308);
}

export async function proxy(request: NextRequest) {
  const redirection = arbitrerDomaine(request);
  if (redirection) {
    return redirection;
  }

  return updateSession(request);
}

export const config = {
  /**
   * Exclut les assets statiques : sans cela, chaque image et chaque fichier CSS
   * déclencherait un appel réseau à Supabase et la logique de redirection
   * pourrait bloquer leur chargement.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)",
  ],
};
