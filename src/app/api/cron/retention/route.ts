import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { getProvider } from "@/server/social/providers";
import { runYouTubeRetention } from "@/server/social/retention";
import { codeErreurControle, consignerPasse } from "@/server/social/retention-journal";
import { createServiceClient } from "@/server/supabase/service-client";
import type { SocialPlatform } from "@/types/platform";

/**
 * Passe de rétention — `POST /api/cron/retention`.
 *
 * Réveillée une fois par jour par pg_cron, via pg_net. Le job existe mais est
 * CRÉÉ DÉSACTIVÉ : l'activer est une décision distincte, prise une fois cette
 * route déployée et vérifiée.
 *
 * L'authentification est celle de `/api/cron/publish`, et volontairement à
 * l'identique : même secret partagé lu dans Vault aux deux extrémités, même
 * comparaison à temps constant, mêmes réponses muettes. Deux mécanismes
 * d'authentification pour deux tâches internes seraient deux surfaces à
 * maintenir, dont l'une finirait par diverger.
 *
 * CETTE ROUTE SUPPRIME DES DONNÉES. Elle ne rend jamais rien d'exploitable à
 * un appelant non autorisé, et ne dit pas non plus ce qui a échoué.
 */

export const dynamic = "force-dynamic";
/** Un lot borné, mais chaque compte implique deux appels distants. */
export const maxDuration = 120;

function secretsMatch(fourni: string, attendu: string): boolean {
  const a = Buffer.from(fourni, "utf8");
  const b = Buffer.from(attendu, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const fourni = request.headers.get("x-postync-cron");
  if (!fourni) {
    return new NextResponse(null, { status: 401 });
  }

  const db = createServiceClient();

  const { data: attendu, error } = await db.rpc("scheduler_secret");
  if (error || typeof attendu !== "string" || attendu.length === 0) {
    // Sans secret configuré, la route reste FERMÉE. Elle purge des comptes :
    // l'ouvrir « le temps de configurer » exposerait une suppression à tout
    // Internet.
    console.error(`[cron:retention] secret indisponible: ${error?.code ?? "absent"}`);
    return new NextResponse(null, { status: 503 });
  }

  if (!secretsMatch(fourni, attendu)) {
    return new NextResponse(null, { status: 401 });
  }

  const debut = Date.now();
  try {
    const rapport = await runYouTubeRetention({
      db,
      getProvider: (platform: string) => getProvider(platform as SocialPlatform),
    });

    // Compteurs et identifiants internes uniquement : aucun jeton, aucun
    // identifiant de chaîne, aucun nom affiché.
    console.log(
      `[cron:retention] examines=${rapport.examines} rafraichis=${rapport.rafraichis} ` +
        `purges=${rapport.purges} reessais=${rapport.reessais} ` +
        `publications=${rapport.publicationsPurgees}`,
    );
    await consignerPasse(db, {
      examined: rapport.examines,
      refreshed: rapport.rafraichis,
      purged: rapport.purges,
      retried: rapport.reessais,
      publications_purged: rapport.publicationsPurgees,
      batches: rapport.lots,
      saturated: rapport.sature,
      duration_ms: Date.now() - debut,
      error_code: null,
    });
    return NextResponse.json({
      examines: rapport.examines,
      rafraichis: rapport.rafraichis,
      purges: rapport.purges,
      reessais: rapport.reessais,
      publicationsPurgees: rapport.publicationsPurgees,
    });
  } catch (err) {
    // Code CONTRÔLÉ partout — dans le log comme en base. Tronquer le message
    // ne garantirait pas l'absence d'une donnée sensible ; un code choisi
    // dans une liste fermée, si.
    const code = codeErreurControle(err);
    console.error(`[cron:retention] ${code}`);
    // Compteurs à NULL, pas à zéro : l'invocation a échoué en vol, son rapport
    // est perdu, et des opérations partielles ont pu avoir lieu. `null` dit
    // « inconnu » ; `0` dirait « mesuré : rien », ce qui serait faux.
    await consignerPasse(db, {
      examined: null,
      refreshed: null,
      purged: null,
      retried: null,
      publications_purged: null,
      batches: null,
      saturated: null,
      duration_ms: Date.now() - debut,
      error_code: code,
    });
    return new NextResponse(null, { status: 500 });
  }
}
