/**
 * C10.3 — construction de la grille du calendrier.
 *
 * De l'arithmétique de dates : la partie qui se trompe en silence et qu'on ne
 * découvre qu'un mois plus tard, aux extrémités. D'où des cas explicites sur
 * les bascules de fuseau, les mois de 28 à 31 jours, et les semaines
 * incomplètes.
 */
import { describe, expect, it } from "vitest";

import {
  adjacentMonths,
  buildMonthGrid,
  dayKey,
  isValidMonth,
  occurrenceOf,
} from "@/server/social/calendar";
import type { SocialPublicationRow } from "@/server/social/accounts";

function publication(overrides: Partial<SocialPublicationRow> = {}): SocialPublicationRow {
  return {
    id: "id",
    workspace_id: "ws",
    social_account_id: "acc",
    platform: "facebook",
    provider_account_id: "1",
    media_kind: "reel",
    media_url: "cle",
    caption: null,
    container_id: null,
    provider_media_id: null,
    permalink: null,
    status: "scheduled",
    status_detail: null,
    created_at: "2026-09-10T10:00:00.000Z",
    published_at: null,
    scheduled_at: null,
    ...overrides,
  };
}

describe("instant retenu pour le placement", () => {
  it("l'échéance prime, puis la publication, puis la création", () => {
    expect(
      occurrenceOf(
        publication({
          scheduled_at: "2026-09-03T08:00:00.000Z",
          published_at: "2026-09-03T08:00:41.000Z",
        }),
      ),
    ).toBe("2026-09-03T08:00:00.000Z");

    // Une publication programmée PUIS publiée reste rangée à son échéance :
    // elle ne doit pas changer de case entre deux consultations.
    expect(occurrenceOf(publication({ published_at: "2026-09-04T12:00:00.000Z" }))).toBe(
      "2026-09-04T12:00:00.000Z",
    );
    expect(occurrenceOf(publication())).toBe("2026-09-10T10:00:00.000Z");
  });
});

describe("jour local et non jour UTC", () => {
  it("une publication de fin de soirée reste au bon jour, et au bon mois", () => {
    // 31 août 22h30 UTC = 1er septembre 00h30 à Paris. Ranger d'après l'UTC
    // l'afficherait le mauvais jour ET le mauvais mois.
    expect(dayKey("2026-08-31T22:30:00.000Z", "Europe/Paris")).toBe("2026-09-01");
    expect(dayKey("2026-08-31T22:30:00.000Z", "UTC")).toBe("2026-08-31");
  });

  it("fonctionne aussi de l'autre côté de la ligne", () => {
    // 1er septembre 02h00 UTC = 31 août 22h00 à New York.
    expect(dayKey("2026-09-01T02:00:00.000Z", "America/New_York")).toBe("2026-08-31");
  });
});

describe("grille du mois", () => {
  it("commence un LUNDI et compte des semaines entières", () => {
    const grille = buildMonthGrid("2026-09", [], "Europe/Paris");
    expect(grille.length % 7).toBe(0);
    // 1er septembre 2026 = un mardi : une seule case de complément avant.
    expect(grille[0].date).toBe("2026-08-31");
    expect(grille[0].inMonth).toBe(false);
    expect(grille[1].date).toBe("2026-09-01");
    expect(grille[1].inMonth).toBe(true);
  });

  it("couvre tous les jours du mois, quelle que soit sa longueur", () => {
    for (const [mois, jours] of [
      ["2026-02", 28],
      ["2028-02", 29],
      ["2026-04", 30],
      ["2026-01", 31],
    ] as const) {
      const grille = buildMonthGrid(mois, [], "Europe/Paris");
      expect(grille.filter((c) => c.inMonth), mois).toHaveLength(jours);
      expect(grille.length % 7, mois).toBe(0);
    }
  });

  it("un mois commençant un lundi n'a aucune case de complément avant", () => {
    // 1er juin 2026 est un lundi.
    const grille = buildMonthGrid("2026-06", [], "Europe/Paris");
    expect(grille[0].date).toBe("2026-06-01");
    expect(grille[0].inMonth).toBe(true);
  });

  it("range chaque publication dans sa case, en heure locale", () => {
    const grille = buildMonthGrid(
      "2026-09",
      [
        publication({ id: "veille-utc", scheduled_at: "2026-08-31T22:30:00.000Z" }),
        publication({ id: "midi", scheduled_at: "2026-09-15T12:00:00.000Z" }),
      ],
      "Europe/Paris",
    );
    const premier = grille.find((c) => c.date === "2026-09-01");
    // Rangée au 1er septembre alors que son instant UTC est le 31 août.
    expect(premier!.entries.map((e) => e.id)).toEqual(["veille-utc"]);
    expect(grille.find((c) => c.date === "2026-09-15")!.entries.map((e) => e.id)).toEqual(["midi"]);
  });

  it("ordonne les publications d'une même journée chronologiquement", () => {
    const grille = buildMonthGrid(
      "2026-09",
      [
        publication({ id: "soir", scheduled_at: "2026-09-10T18:00:00.000Z" }),
        publication({ id: "matin", scheduled_at: "2026-09-10T07:00:00.000Z" }),
        publication({ id: "midi", scheduled_at: "2026-09-10T12:00:00.000Z" }),
      ],
      "Europe/Paris",
    );
    expect(grille.find((c) => c.date === "2026-09-10")!.entries.map((e) => e.id)).toEqual([
      "matin",
      "midi",
      "soir",
    ]);
  });

  it("les cases de complément ne portent jamais de publication", () => {
    const grille = buildMonthGrid(
      "2026-09",
      [publication({ id: "aout", scheduled_at: "2026-08-25T12:00:00.000Z" })],
      "Europe/Paris",
    );
    expect(grille.filter((c) => !c.inMonth).every((c) => c.entries.length === 0)).toBe(true);
  });

  it("un mois invalide ne fait pas exploser la page", () => {
    expect(buildMonthGrid("2026-13", [], "Europe/Paris")).toEqual([]);
    expect(buildMonthGrid("n'importe quoi", [], "Europe/Paris")).toEqual([]);
  });
});

describe("navigation", () => {
  it("passe correctement les bornes d'année", () => {
    expect(adjacentMonths("2026-01")).toEqual({ previous: "2025-12", next: "2026-02" });
    expect(adjacentMonths("2026-12")).toEqual({ previous: "2026-11", next: "2027-01" });
    expect(adjacentMonths("2026-09")).toEqual({ previous: "2026-08", next: "2026-10" });
  });

  it("n'accepte qu'un mois bien formé — le paramètre vient de l'URL", () => {
    expect(isValidMonth("2026-09")).toBe(true);
    expect(isValidMonth("2026-01")).toBe(true);
    expect(isValidMonth("2026-12")).toBe(true);
    expect(isValidMonth("2026-13")).toBe(false);
    expect(isValidMonth("2026-00")).toBe(false);
    expect(isValidMonth("2026-9")).toBe(false);
    expect(isValidMonth("")).toBe(false);
    expect(isValidMonth(undefined)).toBe(false);
  });
});
