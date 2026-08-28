/**
 * Conversion entre heure murale et instant, dans un fuseau donné (C13).
 *
 * POURQUOI CE MODULE EXISTE. Le champ `datetime-local` d'un navigateur ne
 * porte AUCUN fuseau : « 14:30 » y est une heure murale, et rien d'autre.
 * Jusqu'ici on l'interprétait dans le fuseau du NAVIGATEUR, tandis que le
 * calendrier et la vue d'ensemble affichaient en `Europe/Paris` codé en dur.
 * Un client à Montréal programmait donc à une heure et la voyait affichée à
 * une autre — sans qu'aucune erreur ne soit levée nulle part.
 *
 * Le fuseau de référence est désormais celui du WORKSPACE, des deux côtés.
 *
 * Ce module est volontairement PARTAGÉ (pas `server-only`) : le navigateur en
 * a besoin au moment de la saisie, le serveur au moment de l'affichage. Deux
 * implémentations divergeraient.
 */

/** Format attendu par `datetime-local` : `AAAA-MM-JJTHH:mm`. */
const HEURE_MURALE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * Décalage du fuseau à un instant donné, en millisecondes.
 *
 * Il n'est pas constant : un fuseau à heure d'été en change deux fois par an,
 * et certains pays modifient leurs règles. On le MESURE donc à l'instant
 * considéré, plutôt que de le supposer.
 */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));

  const lu: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") lu[part.type] = Number(part.value);
  }
  // Certains moteurs rendent « 24 » pour minuit avec `hour12: false`.
  const heure = lu.hour % 24;
  const commeUtc = Date.UTC(lu.year, lu.month - 1, lu.day, heure, lu.minute, lu.second);
  return commeUtc - instant;
}

/**
 * Instant UTC correspondant à une heure murale dans un fuseau.
 *
 * Deux passes, et la seconde n'est pas du zèle : à une bascule d'heure d'été,
 * le décalage à l'instant approché diffère de celui à l'instant réel. Une
 * seule passe se tromperait d'une heure, deux fois par an — précisément aux
 * dates où l'utilisateur y prête le moins attention.
 *
 * Renvoie `null` si l'entrée n'est pas une heure murale valide.
 */
export function wallClockToInstant(wallClock: string, timeZone: string): Date | null {
  const correspondance = HEURE_MURALE.exec(wallClock);
  if (!correspondance) return null;

  const [, annee, mois, jour, heure, minute] = correspondance.map(Number);
  const naif = Date.UTC(annee, mois - 1, jour, heure, minute);
  if (Number.isNaN(naif)) return null;

  let instant = naif - zoneOffsetMs(naif, timeZone);
  instant = naif - zoneOffsetMs(instant, timeZone);

  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Heure murale d'un instant, au format attendu par `datetime-local`.
 * Réciproque de `wallClockToInstant`.
 */
export function instantToWallClock(instant: number, timeZone: string): string {
  const decalage = zoneOffsetMs(instant, timeZone);
  return new Date(instant + decalage).toISOString().slice(0, 16);
}

/** `AAAA-MM-JJ` d'un instant, dans le fuseau demandé. */
export function dayKeyInZone(iso: string, timeZone: string): string {
  // `en-CA` produit exactement `AAAA-MM-JJ` — aucun autre format court ne le
  // garantit, et celui-ci se trie lexicographiquement.
  return new Date(iso).toLocaleDateString("en-CA", { timeZone });
}

/** Un fuseau IANA que ce navigateur ou ce serveur sait manipuler ? */
export function isKnownTimeZone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fuseaux proposés dans les réglages.
 *
 * Une liste courte plutôt que les ~600 fuseaux IANA : un menu déroulant
 * interminable n'aide personne. Le champ accepte néanmoins n'importe quel
 * fuseau valide côté serveur, et la base le vérifie à l'écriture.
 */
export const COMMON_TIME_ZONES = [
  "Europe/Paris",
  "Europe/Brussels",
  "Europe/Zurich",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Berlin",
  "Africa/Casablanca",
  "Africa/Dakar",
  "Africa/Abidjan",
  "America/Montreal",
  "America/New_York",
  "America/Los_Angeles",
  "America/Cayenne",
  "Indian/Reunion",
  "Pacific/Noumea",
  "UTC",
] as const;

export const DEFAULT_TIME_ZONE = "Europe/Paris";
