import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SocialPublicationRow } from "./accounts";

/**
 * Calendrier des publications (C10.3).
 *
 * La grille est construite ici, hors de tout composant : c'est de
 * l'arithmétique de dates, la partie qui se trompe silencieusement et qu'on ne
 * voit qu'un mois plus tard. Elle est donc pure et testée.
 *
 * TOUT EST EN HEURE LOCALE. Une publication programmée pour le 1er septembre à
 * 00h30 (Paris) tombe le 31 août à 22h30 UTC : la ranger d'après sa date UTC
 * l'afficherait le mauvais jour, et même le mauvais mois. Le rendu se fait
 * donc côté serveur avec un fuseau EXPLICITE, transmis par l'appelant.
 */

/** Une publication telle que le calendrier l'affiche. */
export type CalendarEntry = SocialPublicationRow & {
  /** Instant retenu pour le placement : échéance, publication, ou création. */
  occursAt: string;
};

export type CalendarDay = {
  /** Jour au format `AAAA-MM-JJ`, dans le fuseau demandé. */
  date: string;
  dayOfMonth: number;
  /** Faux pour les jours de complément, en début et fin de grille. */
  inMonth: boolean;
  entries: CalendarEntry[];
};

/**
 * Instant auquel une publication « a lieu ».
 *
 * L'ordre importe : une publication programmée puis publiée reste rangée à son
 * échéance, pour ne pas sauter de case entre deux consultations.
 */
export function occurrenceOf(row: SocialPublicationRow): string {
  return row.scheduled_at ?? row.published_at ?? row.created_at;
}

/** `AAAA-MM-JJ` d'un instant, dans le fuseau demandé. */
export function dayKey(iso: string, timeZone: string): string {
  // `en-CA` produit exactement `AAAA-MM-JJ`, ce qu'aucun autre format court ne
  // garantit — et il se trie lexicographiquement.
  return new Date(iso).toLocaleDateString("en-CA", { timeZone });
}

/**
 * Grille d'un mois, semaines commençant le LUNDI (usage français).
 *
 * `month` est `AAAA-MM`. La grille est complétée pour former des semaines
 * entières : les jours de complément portent `inMonth: false`.
 */
export function buildMonthGrid(
  month: string,
  rows: SocialPublicationRow[],
  timeZone: string,
): CalendarDay[] {
  const [annee, mois] = month.split("-").map(Number);
  if (!annee || !mois || mois < 1 || mois > 12) {
    return [];
  }

  const parJour = new Map<string, CalendarEntry[]>();
  for (const row of rows) {
    const occursAt = occurrenceOf(row);
    const cle = dayKey(occursAt, timeZone);
    const liste = parJour.get(cle) ?? [];
    liste.push({ ...row, occursAt });
    parJour.set(cle, liste);
  }
  // Dans une journée, l'ordre chronologique est le seul qui ait du sens.
  for (const liste of parJour.values()) {
    liste.sort((a, b) => a.occursAt.localeCompare(b.occursAt));
  }

  // Calculs en UTC pur : on manipule des NUMÉROS de jour, pas des instants.
  // Mélanger les deux est la source d'erreur classique de ce genre de code.
  const premier = new Date(Date.UTC(annee, mois - 1, 1));
  const joursDansLeMois = new Date(Date.UTC(annee, mois, 0)).getUTCDate();
  // getUTCDay : 0 = dimanche. On veut 0 = lundi.
  const decalage = (premier.getUTCDay() + 6) % 7;

  const cases: CalendarDay[] = [];
  const ajouter = (date: Date, inMonth: boolean) => {
    const cle = date.toISOString().slice(0, 10);
    cases.push({
      date: cle,
      dayOfMonth: date.getUTCDate(),
      inMonth,
      entries: inMonth ? (parJour.get(cle) ?? []) : [],
    });
  };

  for (let i = decalage; i > 0; i -= 1) {
    ajouter(new Date(Date.UTC(annee, mois - 1, 1 - i)), false);
  }
  for (let jour = 1; jour <= joursDansLeMois; jour += 1) {
    ajouter(new Date(Date.UTC(annee, mois - 1, jour)), true);
  }
  // Compléter la dernière semaine.
  while (cases.length % 7 !== 0) {
    const suivant = cases.length - decalage - joursDansLeMois + 1;
    ajouter(new Date(Date.UTC(annee, mois, suivant)), false);
  }
  return cases;
}

/** Mois précédent et suivant, au format `AAAA-MM`. */
export function adjacentMonths(month: string): { previous: string; next: string } {
  const [annee, mois] = month.split("-").map(Number);
  const decale = (delta: number) => {
    const d = new Date(Date.UTC(annee, mois - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  return { previous: decale(-1), next: decale(1) };
}

/** `AAAA-MM` valide ? Sinon, l'appelant retombe sur le mois courant. */
export function isValidMonth(value: string | undefined): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/**
 * Publications d'un mois.
 *
 * Les bornes sont ÉLARGIES d'un jour de chaque côté : une publication rangée
 * le 1er du mois en heure locale peut porter un instant UTC situé la veille.
 * Sans cette marge, elle disparaîtrait de la grille — le genre de bogue qu'on
 * ne remarque qu'aux extrémités du mois.
 */
export async function listPublicationsForMonth(
  supabase: SupabaseClient,
  workspaceId: string,
  month: string,
): Promise<SocialPublicationRow[]> {
  const [annee, mois] = month.split("-").map(Number);
  const debut = new Date(Date.UTC(annee, mois - 1, 1) - 24 * 3600_000).toISOString();
  const fin = new Date(Date.UTC(annee, mois, 1) + 24 * 3600_000).toISOString();

  const { data, error } = await supabase
    .from("social_publications")
    // Liste explicite : `*` échouerait sur cette table protégée par une liste
    // blanche de colonnes.
    .select(
      "id, workspace_id, social_account_id, platform, provider_account_id, media_kind, " +
        "media_url, caption, container_id, provider_media_id, permalink, status, " +
        "status_detail, created_at, published_at, scheduled_at, effective_at",
    )
    .eq("workspace_id", workspaceId)
    .gte("effective_at", debut)
    .lt("effective_at", fin)
    .order("effective_at", { ascending: true });

  if (error) {
    console.error(`[social:calendar] ${error.code ?? "inconnu"}`);
    return [];
  }
  return (data ?? []) as unknown as SocialPublicationRow[];
}
