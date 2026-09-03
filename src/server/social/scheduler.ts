import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { publishToSocialAccount, resumePublication, type PublishDeps } from "./publish";
import type { PublishMediaKind } from "./providers/types";

/**
 * Exécution des publications programmées (C10.2).
 *
 * Ce module est appelé par `POST /api/cron/publish`, lui-même réveillé chaque
 * minute par pg_cron. Il fait DEUX choses, et aucune n'est facultative :
 *
 *   1. réclamer les échéances dues et les publier ;
 *   2. reprendre les publications restées en cours.
 *
 * La seconde est celle qu'on oublie. Une publication dont le conteneur n'est
 * pas prêt dans le budget d'attente reste `pending` : jusqu'ici seule
 * l'interface pouvait la reprendre, ce qui revenait à espérer qu'un humain
 * regarde à 3 h du matin. Sans elle, la planification serait un piège.
 *
 * CE QUI GARANTIT QU'UNE PUBLICATION NE PART PAS DEUX FOIS. Rien ici n'est
 * laissé au code applicatif : les deux réclamations sont des transitions
 * atomiques faites par la base (`claim_due_publications`,
 * `claim_stale_publications`). Ce module ne traite QUE les lignes que la base
 * lui a attribuées, et `publishToSocialAccount` refuse d'adopter une ligne qui
 * ne serait plus `pending`. Deux réveils concurrents ne peuvent donc pas se
 * disputer la même publication, même si l'un déborde sur l'autre.
 */

/** Lot volontairement petit : mieux vaut plusieurs réveils que l'un interminable. */
export const BATCH_SIZE = 3;
/**
 * Budget par publication, DÉRIVÉ DES LIMITES RÉELLES et non choisi au jugé.
 *
 * `/api/cron/publish` déclare `maxDuration = 120` s. Un réveil traite au pire
 * `BATCH_SIZE` échéances dues PUIS `BATCH_SIZE` reprises, soit 6 publications :
 * 6 × 15 s = 90 s, ce qui laisse 30 s pour les allers-retours en base et la
 * marge d'arrêt de la fonction.
 *
 * Le plancher est l'autre moitié de la contrainte : sous
 * `YOUTUBE_MIN_TRANSFER_BUDGET_MS`, un transfert fractionné ne peut RIEN
 * tenter. Les 8 s précédentes étaient sous ce seuil, et la publication tournait
 * en reprise perpétuelle sans envoyer un octet. Un test confronte désormais ces
 * deux constantes.
 */
export const SCHEDULER_POLL_BUDGET_MS = 15_000;

/**
 * Plafond de tentatives, tenu ICI et passé explicitement à la base : laisser la
 * valeur par défaut des deux côtés les faisait diverger en silence.
 */
export const MAX_ATTEMPTS = 10;

export type SchedulerReport = {
  /** Échéances dues réclamées à ce réveil. */
  claimed: number;
  /** Publications parties jusqu'au bout. */
  published: number;
  /** Encore en cours : conteneur pas prêt, reprise au réveil suivant. */
  stillPending: number;
  /** Échecs définitifs, avec leur code. */
  failed: { publicationId: string; code: string }[];
  /** Publications reprises (conteneur déjà créé). */
  resumed: number;
};

type ClaimedRow = { id: string; workspace_id: string; container_id?: string | null };

type PublicationRow = {
  id: string;
  workspace_id: string;
  social_account_id: string | null;
  media_kind: PublishMediaKind;
  media_url: string;
  media_asset_id: string | null;
  caption: string | null;
  requested_by: string | null;
  /**
   * Déclarations YouTube faites À LA SAISIE. Le planificateur ne les
   * interprète pas : il les relaie. `publish.ts` les revalide à l'adoption de
   * la ligne, et met la publication en échec si elles manquent.
   */
  title: string | null;
  privacy_status: string | null;
  made_for_kids: boolean | null;
  guidelines_acknowledged_at: string | null;
};

export type SchedulerDeps = PublishDeps & {
  /** Taille du lot, injectable pour les tests. */
  batchSize?: number;
  /**
   * Ancienneté à partir de laquelle une publication en cours est reprise.
   * Défaut : le défaut SQL (3 minutes).
   *
   * L'exclusion repose sur `updated_at`, que le trigger remet à `now()` à
   * CHAQUE écriture — le code applicatif ne peut donc pas la falsifier, ce
   * qui est précisément ce qu'on veut d'un verrou. Corollaire : un test ne
   * peut pas vieillir une ligne artificiellement, d'où ce réglage.
   */
  staleAfter?: string;
  /** Plafond de tentatives, injectable pour les tests. Défaut : `MAX_ATTEMPTS`. */
  maxAttempts?: number;
};

/**
 * Un réveil du planificateur. Ne lève jamais : un échec sur une publication
 * ne doit pas empêcher les suivantes de partir.
 */
export async function runScheduler(deps: SchedulerDeps): Promise<SchedulerReport> {
  const limite = deps.batchSize ?? BATCH_SIZE;
  const rapport: SchedulerReport = {
    claimed: 0,
    published: 0,
    stillPending: 0,
    failed: [],
    resumed: 0,
  };

  // Budget d'attente court : ce module rend la main vite.
  const publishDeps: PublishDeps = {
    ...deps,
    pollBudgetMs: deps.pollBudgetMs ?? SCHEDULER_POLL_BUDGET_MS,
  };

  // --- 1. Échéances dues -----------------------------------------------------
  const dues = await claim(deps.db, "claim_due_publications", { p_limit: limite });
  rapport.claimed = dues.length;

  for (const ligne of dues) {
    const publication = await readPublication(deps.db, ligne.id);
    if (!publication) {
      // La ligne a disparu entre la réclamation et sa lecture. Rien à faire :
      // surtout ne rien republier sur une base incertaine.
      continue;
    }
    if (!publication.social_account_id) {
      // Le compte a été déconnecté depuis la programmation. On le DIT, plutôt
      // que de laisser la publication en attente indéfinie.
      await markFailed(deps.db, publication.id, "account_disconnected");
      rapport.failed.push({ publicationId: publication.id, code: "account_disconnected" });
      continue;
    }

    const outcome = await publierDepuis(publishDeps, {
      ...publication,
      social_account_id: publication.social_account_id,
    });

    if (!outcome.ok) {
      rapport.failed.push({ publicationId: publication.id, code: outcome.code });
    } else if (outcome.status === "published") {
      rapport.published += 1;
    } else {
      rapport.stillPending += 1;
    }
  }

  // --- 2. Publications restées en cours --------------------------------------
  const bloquees = await claim(deps.db, "claim_stale_publications", {
    p_limit: limite,
    p_max_attempts: deps.maxAttempts ?? MAX_ATTEMPTS,
    ...(deps.staleAfter ? { p_stale_after: deps.staleAfter } : {}),
  });

  for (const ligne of bloquees) {
    // DEUX cas, et le second est celui qu'on oublie.
    //
    // Conteneur présent : on l'interroge et on publie. Le média n'est JAMAIS
    // renvoyé — c'est tout l'intérêt du conteneur.
    //
    // Conteneur ABSENT : l'exécution est morte entre la réclamation et la
    // création du conteneur. Rien n'est parti chez la plateforme, la ligne
    // peut donc repartir du début SANS risque de doublon. Sans ce cas, une
    // publication réclamée puis interrompue restait `pending` à jamais.
    const outcome = ligne.container_id
      ? await resumePublication(publishDeps, {
          workspaceId: ligne.workspace_id,
          publicationId: ligne.id,
        })
      : await relancerDepuisLaLigne(publishDeps, deps.db, ligne);

    if (outcome === null) {
      continue;
    }
    if (outcome.ok && outcome.status === "published") {
      rapport.published += 1;
      rapport.resumed += 1;
    } else if (outcome.ok) {
      rapport.stillPending += 1;
      rapport.resumed += 1;
    } else {
      rapport.failed.push({ publicationId: ligne.id, code: outcome.code });
    }
  }

  // --- 3. Tentatives épuisées ------------------------------------------------
  //
  // `claim_stale_publications` ne rend QUE les lignes sous le plafond. Une fois
  // celui-ci atteint, la ligne cesse d'être réclamée — mais elle reste
  // `pending`, donc affichée « en cours » à un client qui attendra pour rien,
  // et invisible dans les échecs. Elle doit être conclue.
  //
  // Le conteneur n'est PAS effacé : la session distante peut encore valoir
  // quelque chose, et l'effacer interdirait toute reprise manuelle.
  const epuisees = await lireEpuisees(deps.db, deps.maxAttempts ?? MAX_ATTEMPTS, limite);
  for (const id of epuisees) {
    await markFailed(deps.db, id, "transfer_stalled");
    rapport.failed.push({ publicationId: id, code: "transfer_stalled" });
  }

  return rapport;
}

/**
 * Publications restées `pending` alors qu'elles ne seront plus jamais
 * réclamées. Lecture stricte : ni le conteneur ni le média ne sont touchés.
 */
async function lireEpuisees(
  db: SupabaseClient,
  maxAttempts: number,
  limite: number,
): Promise<string[]> {
  const { data, error } = await db
    .from("social_publications")
    .select("id")
    .eq("status", "pending")
    .gte("attempts", maxAttempts)
    .limit(limite);
  if (error) {
    console.error(`[scheduler] lecture epuisees: ${error.code}`);
    return [];
  }
  return (data ?? []).map((ligne) => (ligne as { id: string }).id);
}

/**
 * Mène à terme une publication DÉJÀ existante. Le point clé est
 * `existingPublicationId` : on ne crée jamais de seconde ligne.
 */
async function publierDepuis(
  deps: PublishDeps,
  publication: PublicationRow & { social_account_id: string },
) {
  return publishToSocialAccount(deps, {
    workspaceId: publication.workspace_id,
    socialAccountId: publication.social_account_id,
    requestedBy: publication.requested_by ?? "",
    mediaKind: publication.media_kind,
    mediaAssetId: publication.media_asset_id,
    // Chemin historique par URL manuelle : la référence stockée EST l'URL.
    mediaUrl: publication.media_asset_id ? undefined : publication.media_url,
    caption: publication.caption,
    // Relayées pour mémoire : `publish.ts` fait autorité en relisant la ligne
    // qu'il adopte. Les passer ici garde le chemin lisible et permet aux tests
    // de vérifier le trajet sans base.
    title: publication.title,
    privacyStatus: publication.privacy_status,
    madeForKids: publication.made_for_kids,
    guidelinesAcknowledged: publication.guidelines_acknowledged_at !== null,
    existingPublicationId: publication.id,
  });
}

/** Relit la ligne réclamée et la relance depuis le début. */
async function relancerDepuisLaLigne(
  publishDeps: PublishDeps,
  db: SupabaseClient,
  ligne: ClaimedRow,
) {
  const publication = await readPublication(db, ligne.id);
  if (!publication || !publication.social_account_id) {
    return null;
  }
  return publierDepuis(publishDeps, {
    ...publication,
    social_account_id: publication.social_account_id,
  });
}

async function claim(
  db: SupabaseClient,
  fonction: "claim_due_publications" | "claim_stale_publications",
  args: Record<string, number | string>,
): Promise<ClaimedRow[]> {
  const { data, error } = await db.rpc(fonction, args);
  if (error) {
    // Journalisé par code court : jamais de payload brut.
    console.error(`[scheduler] ${fonction}: ${error.code ?? "erreur"}`);
    return [];
  }
  return (data ?? []) as ClaimedRow[];
}

async function readPublication(
  db: SupabaseClient,
  id: string,
): Promise<PublicationRow | null> {
  const { data } = await db
    .from("social_publications")
    .select(
      "id, workspace_id, social_account_id, media_kind, media_url, media_asset_id, caption, " +
        "requested_by, title, privacy_status, made_for_kids, guidelines_acknowledged_at",
    )
    .eq("id", id)
    .maybeSingle<PublicationRow>();
  return data ?? null;
}

async function markFailed(db: SupabaseClient, id: string, detail: string): Promise<void> {
  await db
    .from("social_publications")
    .update({ status: "failed", status_detail: detail })
    .eq("id", id);
}
