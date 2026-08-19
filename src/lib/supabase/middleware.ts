import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isSupabaseConfigured, requireSupabaseEnv } from "./env";

/** Préfixes de routes exigeant une session valide. */
const PRIVATE_PREFIXES = ["/app"];

/** Routes d'authentification dont un utilisateur connecté doit être sorti. */
const AUTH_ROUTES = ["/login", "/signup"];

function isPrivate(pathname: string): boolean {
  return PRIVATE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTES.includes(pathname);
}

function redirectTo(request: NextRequest, pathname: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return NextResponse.redirect(url);
}

/**
 * Rafraîchit la session Supabase et applique les redirections d'accès.
 *
 * Appelée depuis `src/proxy.ts` (convention Next.js 16, ex-`middleware.ts`).
 *
 * Deux points de vigilance :
 *
 * 1. Les cookies rafraîchis par Supabase doivent être recopiés sur TOUTE
 *    réponse renvoyée, y compris les redirections, sinon la session est perdue.
 * 2. `setAll` reçoit un second argument `headers` (@supabase/ssr >= 0.12) qui
 *    contient les en-têtes anti-cache. Les omettre exposerait une session à
 *    être mise en cache par un CDN et servie à un autre utilisateur.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Sans configuration Supabase, aucune session n'est possible : on laisse
  // passer les routes publiques et on ferme la zone privée.
  if (!isSupabaseConfigured()) {
    if (isPrivate(pathname)) {
      return redirectTo(request, "/login");
    }
    return NextResponse.next({ request });
  }

  const { url, anonKey } = requireSupabaseEnv();

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        supabaseResponse = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }

        for (const [key, value] of Object.entries(headers)) {
          supabaseResponse.headers.set(key, value);
        }
      },
    },
  });

  // `getUser()` revalide le jeton auprès du serveur d'authentification.
  // Ne pas utiliser `getSession()` ici : son contenu provient des cookies et
  // n'est donc pas digne de confiance pour une décision d'autorisation.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && isPrivate(pathname)) {
    return copyCookies(supabaseResponse, redirectTo(request, "/login"));
  }

  if (user && isAuthRoute(pathname)) {
    return copyCookies(supabaseResponse, redirectTo(request, "/app"));
  }

  return supabaseResponse;
}

/** Reporte les cookies rafraîchis sur une réponse de redirection. */
function copyCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
  return to;
}
