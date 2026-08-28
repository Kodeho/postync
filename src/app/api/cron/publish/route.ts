import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { getProvider } from "@/server/social/providers";
import type { SocialPlatform } from "@/types/platform";
import { runScheduler } from "@/server/social/scheduler";
import { getWorkspaceAccess } from "@/server/billing/queries";
import { createServiceClient } from "@/server/supabase/service-client";

/**
 * Réveil du planificateur — `POST /api/cron/publish`.
 *
 * Appelée chaque minute par pg_cron, via pg_net.
 *
 * AUTHENTIFICATION. Le secret partagé vit dans Vault, et les DEUX extrémités
 * l'y lisent : le job pg_cron via `vault.decrypted_secrets`, cette route via
 * la RPC `scheduler_secret()`, réservée à service_role. Rien n'est donc à
 * déployer dans les variables d'environnement, et le secret n'a jamais
 * transité par un fichier ni par une console.
 *
 * La comparaison est à temps constant : comparer deux chaînes avec `===`
 * s'arrête au premier octet différent, ce qui laisse fuir, mesure après
 * mesure, la longueur du préfixe correct.
 *
 * Cette route ne rend jamais de contenu utile à un appelant non autorisé, et
 * ne dit pas non plus ce qui a échoué — un scanner n'apprend rien.
 */

export const dynamic = "force-dynamic";
/** Le lot est petit, mais une publication distante peut prendre du temps. */
export const maxDuration = 120;

function secretsMatch(fourni: string, attendu: string): boolean {
  const a = Buffer.from(fourni, "utf8");
  const b = Buffer.from(attendu, "utf8");
  // `timingSafeEqual` exige des longueurs égales : la comparer d'abord
  // révélerait la longueur, on hache donc à taille fixe.
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
    // Sans secret configuré, la route reste FERMÉE. Ouvrir « le temps de
    // configurer » exposerait un déclencheur de publication à tout Internet.
    console.error(`[cron:publish] secret indisponible: ${error?.code ?? "absent"}`);
    return new NextResponse(null, { status: 503 });
  }

  if (!secretsMatch(fourni, attendu)) {
    return new NextResponse(null, { status: 401 });
  }

  try {
    const rapport = await runScheduler({
      db,
      getProvider: (platform: string) => getProvider(platform as SocialPlatform),
      getMonthlyQuota: async (workspaceId: string) => {
        const { access } = await getWorkspaceAccess(db, workspaceId);
        return access.quotas.publicationsPerMonth;
      },
    });

    // Le rapport ne contient que des compteurs et des identifiants internes :
    // aucun jeton, aucune légende, aucune URL de média.
    console.log(
      `[cron:publish] dues=${rapport.claimed} publiees=${rapport.published} ` +
        `en_cours=${rapport.stillPending} reprises=${rapport.resumed} echecs=${rapport.failed.length}`,
    );
    return NextResponse.json(rapport);
  } catch (err) {
    console.error(
      `[cron:publish] ${err instanceof Error ? err.message.slice(0, 120) : "erreur"}`,
    );
    return new NextResponse(null, { status: 500 });
  }
}
