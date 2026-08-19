import type { NextRequest } from "next/server";

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
 */
export async function proxy(request: NextRequest) {
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
