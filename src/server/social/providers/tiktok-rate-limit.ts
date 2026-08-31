import "server-only";

import { createHash } from "node:crypto";

/**
 * Limiteur de débit TikTok — fenêtre glissante, par jeton et par endpoint.
 *
 * TikTok publie des plafonds DIFFÉRENTS par endpoint, tous exprimés « par
 * user access_token » (documentation Content Posting API, vérifiée le
 * 2026-08-31) :
 *
 *   · /v2/post/publish/creator_info/query/ ....... 20 requêtes / minute
 *   · /v2/post/publish/video/init/ ................ 6 requêtes / minute
 *   · /v2/post/publish/status/fetch/ ............. 30 requêtes / minute
 *
 * Le plus serré — 6/min sur l'initialisation — est celui qui compte : une
 * publication programmée traitant un lot de plusieurs médias pour le MÊME
 * compte les enchaîne, et six suffisent à toucher le plafond. Un HTTP 429 en
 * plein `video/init/` est particulièrement coûteux : on ne sait pas si TikTok
 * a déjà accepté la tâche, donc on ne peut pas simplement réessayer.
 *
 * PORTÉE — à lire avant de s'y fier :
 *
 *   Ce limiteur est EN MÉMOIRE, donc valable pour une instance. Sur Vercel,
 *   plusieurs instances peuvent coexister : il ne GARANTIT donc pas le
 *   respect du plafond, il le rend seulement improbable dans le cas qui nous
 *   concerne réellement — un lot traité par un seul processus. La garantie,
 *   elle, reste le traitement du 429 renvoyé par TikTok, qui n'est pas
 *   optionnel pour autant. Les deux se complètent ; aucun ne remplace l'autre.
 *
 * La clé est un HACHÉ du jeton, jamais le jeton : un `Map` vit en mémoire du
 * processus, s'imprime dans un dump et n'a aucune raison de contenir un
 * secret exploitable.
 */

export type RateLimitClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const HORLOGE_REELLE: RateLimitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Plafonds officiels, par minute et par jeton utilisateur. */
export const TIKTOK_RATE_LIMITS = {
  creatorInfo: 20,
  videoInit: 6,
  statusFetch: 30,
} as const;

export type TikTokEndpoint = keyof typeof TIKTOK_RATE_LIMITS;

const FENETRE_MS = 60_000;

/**
 * Attente maximale acceptée pour obtenir un créneau. Au-delà, on renonce :
 * une requête HTTP qui patiente une minute entière est déjà perdue pour
 * l'appelant, et il vaut mieux un échec net et repris plus tard qu'une
 * fonction bloquée.
 */
const ATTENTE_MAX_MS = 20_000;

/** Horodatages des appels récents, par clé. */
const APPELS = new Map<string, number[]>();

function cle(endpoint: TikTokEndpoint, accessToken: string): string {
  const empreinte = createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
  return `${endpoint}:${empreinte}`;
}

/** Erreur levée quand le créneau ne peut pas être obtenu dans le budget. */
export class TikTokRateLimitError extends Error {
  constructor(readonly endpoint: TikTokEndpoint) {
    super(`tiktok ${endpoint}: plafond local atteint`);
    this.name = "TikTokRateLimitError";
  }
}

/**
 * Réserve un créneau pour un appel, en patientant si nécessaire.
 *
 * Le créneau est consommé À LA RÉSERVATION, pas au retour de l'appel : c'est
 * la requête qui compte pour TikTok, qu'elle réussisse ou non.
 */
export async function acquireTikTokSlot(
  endpoint: TikTokEndpoint,
  accessToken: string,
  horloge: RateLimitClock = HORLOGE_REELLE,
): Promise<void> {
  const limite = TIKTOK_RATE_LIMITS[endpoint];
  const k = cle(endpoint, accessToken);
  const debut = horloge.now();

  for (;;) {
    const maintenant = horloge.now();
    const recents = (APPELS.get(k) ?? []).filter((t) => maintenant - t < FENETRE_MS);

    if (recents.length < limite) {
      recents.push(maintenant);
      APPELS.set(k, recents);
      elaguer(maintenant);
      return;
    }

    // Le créneau se libère à l'expiration du PLUS ANCIEN appel de la fenêtre.
    const attente = FENETRE_MS - (maintenant - recents[0]) + 50;
    if (maintenant - debut + attente > ATTENTE_MAX_MS) {
      APPELS.set(k, recents);
      throw new TikTokRateLimitError(endpoint);
    }
    APPELS.set(k, recents);
    await horloge.sleep(attente);
  }
}

/**
 * Purge des clés dont tous les appels sont sortis de la fenêtre. Sans cela,
 * un processus de longue durée accumulerait une entrée par jeton vu.
 */
function elaguer(maintenant: number): void {
  for (const [k, appels] of APPELS) {
    if (appels.every((t) => maintenant - t >= FENETRE_MS)) {
      APPELS.delete(k);
    }
  }
}

/** Remise à zéro — réservée aux tests, qui doivent partir d'un état connu. */
export function resetTikTokRateLimits(): void {
  APPELS.clear();
}
