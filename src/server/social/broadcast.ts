import "server-only";

import { publishToSocialAccount, type PublishDeps } from "./publish";
import type { PublishMediaKind } from "./providers/types";
import { schedulePublication, validateScheduledAt } from "./schedule";

/**
 * Publication vers PLUSIEURS réseaux en une seule demande (C11).
 *
 * C'est la promesse du produit — « Create once. Publish everywhere. » — et
 * jusqu'ici elle n'était pas tenue : on publiait réseau par réseau depuis la
 * page Comptes sociaux.
 *
 * TROIS PRINCIPES, tous dictés par ce qui peut mal tourner.
 *
 * 1. LE QUOTA EST VÉRIFIÉ POUR LE LOT ENTIER, AVANT d'envoyer quoi que ce
 *    soit. Sinon, un utilisateur à qui il reste deux publications et qui en
 *    demande trois en verrait partir deux, puis récolterait un échec — deux
 *    contenus publiés qu'il n'a pas choisis de dissocier. Mieux vaut refuser
 *    l'ensemble et le dire.
 *
 * 2. UN ÉCHEC PARTIEL RESTE UN ÉCHEC PARTIEL. Publier sur trois réseaux dont
 *    un refuse ne doit ressembler ni à une réussite ni à un échec : le
 *    résultat est rendu réseau PAR réseau. C'est le seul affichage honnête.
 *
 * 3. CHAQUE RÉSEAU EST INDÉPENDANT. Un refus d'Instagram n'empêche pas
 *    Facebook de partir : chaque cible est traitée dans son propre appel, avec
 *    ses propres contrôles (compte du workspace, scopes, compatibilité du
 *    média). Rien n'est mutualisé qui ne doive l'être.
 *
 * Rien n'est réécrit ici : ce module ORCHESTRE `publishToSocialAccount` et
 * `schedulePublication`, validés en C8 et C10. Il n'y touche pas.
 */

/**
 * Attente par réseau, volontairement courte.
 *
 * Une diffusion vers quatre comptes avec le budget complet immobiliserait la
 * requête plusieurs minutes. Ce qui n'aboutit pas reste `pending` avec son
 * conteneur, et le planificateur le reprend — le média n'est jamais renvoyé.
 */
export const BROADCAST_POLL_BUDGET_MS = 12_000;

/** Au-delà, c'est une erreur de saisie, pas une intention. */
export const MAX_TARGETS = 20;

export type BroadcastTargetOutcome = {
  socialAccountId: string;
  /** `published` · `pending` · `scheduled` · `failed`. */
  status: "published" | "pending" | "scheduled" | "failed";
  publicationId: string | null;
  permalink: string | null;
  /** Code court en cas d'échec. Jamais de réponse brute de plateforme. */
  code: string | null;
};

export type BroadcastOutcome =
  | { ok: true; results: BroadcastTargetOutcome[] }
  | {
      ok: false;
      code: "no_target" | "too_many_targets" | "quota_exceeded" | "schedule_invalid";
      /** Publications restant au plan ce mois-ci, quand le quota est en cause. */
      remaining?: number;
    };

export type BroadcastRequest = {
  workspaceId: string;
  requestedBy: string;
  mediaKind: PublishMediaKind;
  mediaAssetId: string;
  caption: string | null;
  /**
   * Titre YouTube. Ignoré par les autres réseaux : seul `videos.insert` en
   * exige un, et POSTYNC ne va pas imposer un titre là où la plateforme n'en
   * a pas la notion.
   */
  title?: string | null;
  /** Métadonnées YouTube — voir `lib/youtube-metadata.ts`. */
  privacyStatus?: string | null;
  madeForKids?: boolean | null;
  guidelinesAcknowledged?: boolean | null;
  /** Comptes visés. Chacun est revérifié contre le workspace en aval. */
  socialAccountIds: string[];
  /** Échéance ISO, ou null pour publier tout de suite. */
  scheduledAt: string | null;
  shareToFeed?: boolean;
};

export type BroadcastDeps = PublishDeps & {
  /** Publications déjà comptées dans le quota du mois visé. */
  countUsedThisMonth: (workspaceId: string, month: number) => Promise<number>;
};

export async function broadcastPublication(
  deps: BroadcastDeps,
  request: BroadcastRequest,
): Promise<BroadcastOutcome> {
  // Doublons retirés : sélectionner deux fois le même compte ne doit pas
  // publier deux fois, ni consommer deux fois le quota.
  const cibles = [...new Set(request.socialAccountIds)];

  if (cibles.length === 0) {
    return { ok: false, code: "no_target" };
  }
  if (cibles.length > MAX_TARGETS) {
    return { ok: false, code: "too_many_targets" };
  }

  const now = deps.now ?? Date.now;
  let echeance: string | null = null;
  if (request.scheduledAt) {
    const valide = validateScheduledAt(request.scheduledAt, now());
    if (!valide.ok) {
      // Le motif précis est redonné par l'appelant, qui connaît les libellés.
      return { ok: false, code: "schedule_invalid" };
    }
    echeance = valide.iso;
  }

  // Quota du LOT. Le mois visé est celui de l'échéance, pas celui de la
  // saisie — même règle que la planification.
  const moisVise = echeance ? new Date(echeance).getTime() : now();
  const [quota, utilisees] = await Promise.all([
    deps.getMonthlyQuota(request.workspaceId),
    deps.countUsedThisMonth(request.workspaceId, moisVise),
  ]);
  const restantes = Math.max(0, quota - utilisees);
  if (cibles.length > restantes) {
    return { ok: false, code: "quota_exceeded", remaining: restantes };
  }

  const publishDeps: PublishDeps = {
    ...deps,
    pollBudgetMs: deps.pollBudgetMs ?? BROADCAST_POLL_BUDGET_MS,
  };

  const results: BroadcastTargetOutcome[] = [];

  // SÉQUENTIEL, délibérément. En parallèle, les contrôles de quota internes de
  // `publishToSocialAccount` liraient tous le même compteur d'avant l'envoi et
  // pourraient laisser passer plus de publications que le plan n'en autorise.
  for (const socialAccountId of cibles) {
    if (echeance) {
      const planifie = await schedulePublication(publishDeps, {
        workspaceId: request.workspaceId,
        socialAccountId,
        requestedBy: request.requestedBy,
        mediaKind: request.mediaKind,
        mediaAssetId: request.mediaAssetId,
        caption: request.caption,
        title: request.title ?? null,
        privacyStatus: request.privacyStatus ?? null,
        madeForKids: request.madeForKids ?? null,
        guidelinesAcknowledged: request.guidelinesAcknowledged ?? null,
        scheduledAt: echeance,
      });
      results.push(
        planifie.ok
          ? {
              socialAccountId,
              status: "scheduled",
              publicationId: planifie.publicationId,
              permalink: null,
              code: null,
            }
          : {
              socialAccountId,
              status: "failed",
              publicationId: null,
              permalink: null,
              code: planifie.code,
            },
      );
      continue;
    }

    const outcome = await publishToSocialAccount(publishDeps, {
      workspaceId: request.workspaceId,
      socialAccountId,
      requestedBy: request.requestedBy,
      mediaKind: request.mediaKind,
      mediaAssetId: request.mediaAssetId,
      caption: request.caption,
      title: request.title ?? null,
      privacyStatus: request.privacyStatus ?? null,
      madeForKids: request.madeForKids ?? null,
      guidelinesAcknowledged: request.guidelinesAcknowledged ?? null,
      shareToFeed: request.shareToFeed,
    });

    if (!outcome.ok) {
      results.push({
        socialAccountId,
        status: "failed",
        publicationId: outcome.publicationId,
        permalink: null,
        code: outcome.code,
      });
    } else {
      results.push({
        socialAccountId,
        status: outcome.status,
        publicationId: outcome.publicationId,
        permalink: outcome.status === "published" ? outcome.permalink : null,
        code: null,
      });
    }
  }

  return { ok: true, results };
}

/** Un lot où RIEN n'a abouti — utile pour choisir le ton du message. */
export function everyTargetFailed(results: BroadcastTargetOutcome[]): boolean {
  return results.length > 0 && results.every((r) => r.status === "failed");
}

/** Un lot partiellement abouti : ni réussite ni échec, et il faut le dire. */
export function isPartialSuccess(results: BroadcastTargetOutcome[]): boolean {
  return results.some((r) => r.status === "failed") && results.some((r) => r.status !== "failed");
}
