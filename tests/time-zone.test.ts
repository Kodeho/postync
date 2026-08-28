/**
 * C13 — conversion entre heure murale et instant.
 *
 * C'est le genre de code qui se trompe sans rien dire : l'erreur ne se voit
 * qu'aux bascules d'heure d'été, deux fois par an, et sur les fuseaux qu'on
 * n'utilise pas soi-même. D'où des cas explicites et vérifiables à la main.
 */
import { describe, expect, it } from "vitest";

import {
  COMMON_TIME_ZONES,
  DEFAULT_TIME_ZONE,
  dayKeyInZone,
  instantToWallClock,
  isKnownTimeZone,
  wallClockToInstant,
  zoneOffsetMs,
} from "@/lib/time-zone";

const HEURE = 3600_000;

describe("décalage d'un fuseau", () => {
  it("suit l'heure d'été plutôt que de la supposer constante", () => {
    // Paris : UTC+1 en hiver, UTC+2 en été.
    expect(zoneOffsetMs(Date.parse("2026-01-15T12:00:00Z"), "Europe/Paris")).toBe(HEURE);
    expect(zoneOffsetMs(Date.parse("2026-07-15T12:00:00Z"), "Europe/Paris")).toBe(2 * HEURE);
  });

  it("gère les fuseaux à l'ouest et ceux sans changement d'heure", () => {
    expect(zoneOffsetMs(Date.parse("2026-01-15T12:00:00Z"), "America/New_York")).toBe(-5 * HEURE);
    expect(zoneOffsetMs(Date.parse("2026-07-15T12:00:00Z"), "America/New_York")).toBe(-4 * HEURE);
    // Abidjan ne change jamais d'heure.
    expect(zoneOffsetMs(Date.parse("2026-01-15T12:00:00Z"), "Africa/Abidjan")).toBe(0);
    expect(zoneOffsetMs(Date.parse("2026-07-15T12:00:00Z"), "Africa/Abidjan")).toBe(0);
    // La Réunion : UTC+4 toute l'année.
    expect(zoneOffsetMs(Date.parse("2026-01-15T12:00:00Z"), "Indian/Reunion")).toBe(4 * HEURE);
  });

  it("mesure correctement autour de minuit", () => {
    // Un moteur qui rend « 24 » pour minuit fausserait le calcul d'un jour.
    expect(zoneOffsetMs(Date.parse("2026-07-14T22:00:00Z"), "Europe/Paris")).toBe(2 * HEURE);
    expect(zoneOffsetMs(Date.parse("2026-07-14T23:30:00Z"), "Europe/Paris")).toBe(2 * HEURE);
  });
});

describe("heure murale vers instant", () => {
  it("interprète l'heure saisie DANS le fuseau demandé", () => {
    // 14h30 à Paris en été = 12h30 UTC.
    expect(wallClockToInstant("2026-07-15T14:30", "Europe/Paris")!.toISOString()).toBe(
      "2026-07-15T12:30:00.000Z",
    );
    // La même saisie à New York = 18h30 UTC. C'est tout l'enjeu : une même
    // frappe au clavier ne désigne pas le même instant.
    expect(wallClockToInstant("2026-07-15T14:30", "America/New_York")!.toISOString()).toBe(
      "2026-07-15T18:30:00.000Z",
    );
    expect(wallClockToInstant("2026-07-15T14:30", "UTC")!.toISOString()).toBe(
      "2026-07-15T14:30:00.000Z",
    );
  });

  it("reste juste en hiver comme en été", () => {
    // 14h30 à Paris en hiver = 13h30 UTC — une heure de plus qu'en été.
    expect(wallClockToInstant("2026-01-15T14:30", "Europe/Paris")!.toISOString()).toBe(
      "2026-01-15T13:30:00.000Z",
    );
  });

  it("ne se trompe pas d'une heure aux BASCULES d'heure d'été", () => {
    // En 2026, Paris passe à l'heure d'été le 29 mars et en sort le 25 octobre.
    // La veille et le lendemain doivent tomber du bon côté.
    expect(wallClockToInstant("2026-03-28T12:00", "Europe/Paris")!.toISOString()).toBe(
      "2026-03-28T11:00:00.000Z",
    );
    expect(wallClockToInstant("2026-03-30T12:00", "Europe/Paris")!.toISOString()).toBe(
      "2026-03-30T10:00:00.000Z",
    );
    expect(wallClockToInstant("2026-10-24T12:00", "Europe/Paris")!.toISOString()).toBe(
      "2026-10-24T10:00:00.000Z",
    );
    expect(wallClockToInstant("2026-10-26T12:00", "Europe/Paris")!.toISOString()).toBe(
      "2026-10-26T11:00:00.000Z",
    );
  });

  it("refuse ce qui n'est pas une heure murale", () => {
    for (const invalide of ["", "pas une date", "2026-07-15", "2026-07-15 14:30", "15/07/2026"]) {
      expect(wallClockToInstant(invalide, "Europe/Paris"), invalide).toBeNull();
    }
  });
});

describe("aller-retour", () => {
  it("instant → heure murale → instant redonne le même instant", () => {
    for (const zone of ["Europe/Paris", "America/New_York", "Indian/Reunion", "UTC"]) {
      for (const iso of [
        "2026-01-15T13:30:00.000Z",
        "2026-07-15T12:30:00.000Z",
        "2026-10-24T22:45:00.000Z",
      ]) {
        const instant = Date.parse(iso);
        const murale = instantToWallClock(instant, zone);
        expect(wallClockToInstant(murale, zone)!.toISOString(), `${zone} ${iso}`).toBe(iso);
      }
    }
  });
});

describe("jour local", () => {
  it("range au bon jour, y compris à cheval sur minuit", () => {
    // 31 août 22h30 UTC = 1er septembre 00h30 à Paris.
    expect(dayKeyInZone("2026-08-31T22:30:00.000Z", "Europe/Paris")).toBe("2026-09-01");
    expect(dayKeyInZone("2026-08-31T22:30:00.000Z", "UTC")).toBe("2026-08-31");
    // 1er septembre 02h00 UTC = 31 août 22h00 à New York.
    expect(dayKeyInZone("2026-09-01T02:00:00.000Z", "America/New_York")).toBe("2026-08-31");
  });
});

describe("validation d'un fuseau", () => {
  it("accepte les fuseaux IANA connus et rejette le reste", () => {
    expect(isKnownTimeZone("Europe/Paris")).toBe(true);
    expect(isKnownTimeZone("UTC")).toBe(true);
    // Une faute de frappe produirait un calendrier silencieusement décalé.
    expect(isKnownTimeZone("Europe/Pariss")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
    expect(isKnownTimeZone("n'importe quoi")).toBe(false);
    expect(isKnownTimeZone("A".repeat(200))).toBe(false);
  });

  it("tous les fuseaux proposés sont valides, et le défaut en fait partie", () => {
    for (const zone of COMMON_TIME_ZONES) {
      expect(isKnownTimeZone(zone), zone).toBe(true);
    }
    expect(COMMON_TIME_ZONES).toContain(DEFAULT_TIME_ZONE);
  });
});
