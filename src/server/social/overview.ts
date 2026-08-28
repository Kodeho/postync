import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { effectiveStatus, type SocialAccountRow, type SocialPublicationRow } from "./accounts";
import { occurrenceOf } from "./calendar";

/**
 * Vue d'ensemble du workspace (C12).
 *
 * L'écran d'accueil affichait quatre tirets et « Aucune publication pour le
 * moment » à un workspace qui en comptait huit. Un premier écran qui ment sur
 * l'état du compte est pire qu'un écran vide : il apprend à l'utilisateur à ne
 * pas s'y fier.
 *
 * MAIS LE POINT CENTRAL EST AILLEURS. Programmer une publication sert
 * précisément à ne PAS surveiller. Si une publication de 3 h du matin échoue
 * et que rien ne le signale, la promesse ne tient pas : l'utilisateur
 * l'apprendra des jours plus tard, en ouvrant un calendrier par hasard. Cette
 * vue fait donc remonter, en premier, ce qui EXIGE UNE ACTION :
 *
 *   * les publications en échec, avec leur raison ;
 *   * les comptes dont l'autorisation ne fonctionne plus.
 *
 * Le reste — compteurs, prochaines échéances — vient après. Un tableau de bord
 * qui met en avant ce qui va bien et enterre ce qui ne va pas se trompe de
 * métier.
 */

/** Fenêtre de remontée des échecs : au-delà, l'information n'est plus utile. */
export const FAILURE_WINDOW_DAYS = 14;
/** Nombre d'échéances à venir affichées. */
export const UPCOMING_LIMIT = 5;

export type OverviewCounts = {
  /** Publiées aujourd'hui, dans le fuseau demandé. */
  publishedToday: number;
  /** Programmées à venir, toutes dates confondues. */
  upcoming: number;
  /** Publiées ce mois-ci. */
  publishedThisMonth: number;
  /** En échec sur la fenêtre de remontée. */
  failedRecently: number;
};

export type AttentionItem =
  | {
      kind: "publication_failed";
      publicationId: string;
      platform: string;
      caption: string | null;
      detail: string | null;
      occurredAt: string;
    }
  | {
      kind: "account_unusable";
      accountId: string;
      platform: string;
      label: string;
      status: string;
    };

export type Overview = {
  counts: OverviewCounts;
  /** Ce qui exige une action, le plus récent d'abord. */
  attention: AttentionItem[];
  /** Prochaines échéances, la plus proche d'abord. */
  upcoming: SocialPublicationRow[];
};

/** `AAAA-MM-JJ` d'un instant, dans le fuseau demandé. */
function dayKey(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone });
}

/**
 * Construit la vue à partir des lignes déjà lues. Pure, donc testable — la
 * partie qui compte est le classement de ce qui exige une action, et elle ne
 * doit pas dépendre d'un aller-retour en base pour être vérifiée.
 */
export function buildOverview(
  publications: SocialPublicationRow[],
  accounts: SocialAccountRow[],
  options: { now: number; timeZone: string },
): Overview {
  const { now, timeZone } = options;
  const aujourdhui = dayKey(new Date(now).toISOString(), timeZone);
  const debutDuMois = new Date(now).toLocaleDateString("en-CA", { timeZone }).slice(0, 7);
  const limiteEchecs = now - FAILURE_WINDOW_DAYS * 24 * 3600_000;

  const counts: OverviewCounts = {
    publishedToday: 0,
    upcoming: 0,
    publishedThisMonth: 0,
    failedRecently: 0,
  };
  const attention: AttentionItem[] = [];
  const upcoming: SocialPublicationRow[] = [];

  for (const publication of publications) {
    const instant = occurrenceOf(publication);
    const horodatage = new Date(instant).getTime();

    if (publication.status === "published") {
      if (publication.published_at && dayKey(publication.published_at, timeZone) === aujourdhui) {
        counts.publishedToday += 1;
      }
      if (
        publication.published_at &&
        dayKey(publication.published_at, timeZone).startsWith(debutDuMois)
      ) {
        counts.publishedThisMonth += 1;
      }
      continue;
    }

    if (publication.status === "scheduled" && horodatage > now) {
      counts.upcoming += 1;
      upcoming.push(publication);
      continue;
    }

    if (publication.status === "failed" && horodatage >= limiteEchecs) {
      counts.failedRecently += 1;
      attention.push({
        kind: "publication_failed",
        publicationId: publication.id,
        platform: publication.platform,
        caption: publication.caption,
        detail: publication.status_detail,
        occurredAt: instant,
      });
    }
  }

  // Un compte inutilisable bloque TOUTES ses publications à venir : il passe
  // donc avant les échecs déjà constatés, qui sont du passé.
  for (const compte of accounts) {
    const statut = effectiveStatus(compte, now);
    if (statut === "active") continue;
    attention.unshift({
      kind: "account_unusable",
      accountId: compte.id,
      platform: compte.platform,
      label: compte.display_name ?? compte.provider_account_id,
      status: statut,
    });
  }

  upcoming.sort((a, b) => occurrenceOf(a).localeCompare(occurrenceOf(b)));

  return { counts, attention, upcoming: upcoming.slice(0, UPCOMING_LIMIT) };
}

/**
 * Publications à considérer pour la vue d'ensemble.
 *
 * La borne basse est la PLUS ANCIENNE des deux dates utiles : le début du mois
 * courant (pour le compteur mensuel) et la fenêtre de remontée des échecs. Ne
 * garder que la seconde amputerait le compteur mensuel dès le 15 du mois — un
 * chiffre faux, affiché avec aplomb.
 *
 * Il n'y a pas de borne HAUTE : une échéance dans six mois doit apparaître
 * dans « à venir ».
 */
export async function listOverviewPublications(
  supabase: SupabaseClient,
  workspaceId: string,
  now: number = Date.now(),
): Promise<SocialPublicationRow[]> {
  const date = new Date(now);
  const debutDuMois = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const fenetreEchecs = now - FAILURE_WINDOW_DAYS * 24 * 3600_000;
  const depuis = new Date(Math.min(debutDuMois, fenetreEchecs)).toISOString();

  const { data, error } = await supabase
    .from("social_publications")
    // Liste explicite : `*` échouerait sur cette table protégée par une liste
    // blanche de colonnes.
    .select(
      "id, workspace_id, social_account_id, platform, provider_account_id, media_kind, " +
        "media_url, caption, container_id, provider_media_id, permalink, status, " +
        "status_detail, created_at, published_at, scheduled_at",
    )
    .eq("workspace_id", workspaceId)
    .gte("effective_at", depuis)
    .order("effective_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error(`[social:overview] ${error.code ?? "inconnu"}`);
    return [];
  }
  return (data ?? []) as unknown as SocialPublicationRow[];
}
