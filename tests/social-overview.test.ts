/**
 * C12 — vue d'ensemble : ce qui compte, et ce qui exige une action.
 *
 * Deux exigences, et la seconde est la vraie raison d'être de cet écran.
 *
 * Les COMPTEURS doivent être exacts : un premier écran qui annonce « aucune
 * publication » à un workspace qui en compte huit apprend à l'utilisateur à ne
 * pas s'y fier, et il ne s'y fiera plus jamais.
 *
 * Ce qui EXIGE UNE ACTION doit remonter en premier. Programmer sert à ne pas
 * surveiller : si un échec de 3 h du matin ne se voit nulle part, la fonction
 * ne tient pas sa promesse.
 */
import { describe, expect, it } from "vitest";

import { buildOverview, FAILURE_WINDOW_DAYS, UPCOMING_LIMIT } from "@/server/social/overview";
import type { SocialAccountRow, SocialPublicationRow } from "@/server/social/accounts";

const MAINTENANT = Date.parse("2026-09-15T12:00:00.000Z");
const ZONE = "Europe/Paris";
const JOUR = 24 * 3600_000;

function publication(overrides: Partial<SocialPublicationRow> = {}): SocialPublicationRow {
  return {
    id: `p-${Math.random().toString(36).slice(2, 8)}`,
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
    status: "published",
    status_detail: null,
    created_at: new Date(MAINTENANT).toISOString(),
    published_at: null,
    scheduled_at: null,
    ...overrides,
  };
}

function compte(overrides: Partial<SocialAccountRow> = {}): SocialAccountRow {
  return {
    id: `a-${Math.random().toString(36).slice(2, 8)}`,
    platform: "facebook",
    provider_account_id: "1",
    display_name: "Page",
    avatar_url: null,
    status: "active",
    status_detail: null,
    token_expires_at: null,
    refresh_expires_at: null,
    can_refresh: false,
    scopes: [],
    connected_at: new Date(MAINTENANT).toISOString(),
    ...overrides,
  } as unknown as SocialAccountRow;
}

const options = { now: MAINTENANT, timeZone: ZONE };

describe("compteurs", () => {
  it("compte le jour et le mois en heure LOCALE", () => {
    const vue = buildOverview(
      [
        // 14 sept. 23h30 UTC = 15 sept. 01h30 à Paris : c'est AUJOURD'HUI.
        publication({ status: "published", published_at: "2026-09-14T23:30:00.000Z" }),
        // 15 sept. 10h00 UTC : aujourd'hui aussi.
        publication({ status: "published", published_at: "2026-09-15T10:00:00.000Z" }),
        // 3 sept. : ce mois-ci, mais pas aujourd'hui.
        publication({ status: "published", published_at: "2026-09-03T10:00:00.000Z" }),
        // 31 août 23h00 UTC = 1er sept. 01h00 à Paris : bascule de MOIS.
        publication({ status: "published", published_at: "2026-08-31T23:00:00.000Z" }),
      ],
      [],
      options,
    );
    expect(vue.counts.publishedToday).toBe(2);
    expect(vue.counts.publishedThisMonth).toBe(4);
  });

  it("ne compte comme « à venir » que ce qui est encore devant", () => {
    const vue = buildOverview(
      [
        publication({ status: "scheduled", scheduled_at: new Date(MAINTENANT + JOUR).toISOString() }),
        publication({ status: "scheduled", scheduled_at: new Date(MAINTENANT + 2 * JOUR).toISOString() }),
        // Échéance passée restée `scheduled` : le planificateur va la
        // réclamer d'un instant à l'autre. L'annoncer « à venir » serait faux.
        publication({ status: "scheduled", scheduled_at: new Date(MAINTENANT - 60_000).toISOString() }),
      ],
      [],
      options,
    );
    expect(vue.counts.upcoming).toBe(2);
    expect(vue.upcoming).toHaveLength(2);
  });

  it("les échéances à venir sont ordonnées, la plus proche d'abord", () => {
    const vue = buildOverview(
      [
        publication({ id: "loin", status: "scheduled", scheduled_at: new Date(MAINTENANT + 9 * JOUR).toISOString() }),
        publication({ id: "proche", status: "scheduled", scheduled_at: new Date(MAINTENANT + JOUR).toISOString() }),
        publication({ id: "median", status: "scheduled", scheduled_at: new Date(MAINTENANT + 4 * JOUR).toISOString() }),
      ],
      [],
      options,
    );
    expect(vue.upcoming.map((p) => p.id)).toEqual(["proche", "median", "loin"]);
  });

  it("la liste des échéances est bornée, pas le compteur", () => {
    const nombreuses = Array.from({ length: UPCOMING_LIMIT + 4 }, (_, i) =>
      publication({
        status: "scheduled",
        scheduled_at: new Date(MAINTENANT + (i + 1) * JOUR).toISOString(),
      }),
    );
    const vue = buildOverview(nombreuses, [], options);
    // Le compteur dit la vérité ; la liste n'en montre que le début.
    expect(vue.counts.upcoming).toBe(UPCOMING_LIMIT + 4);
    expect(vue.upcoming).toHaveLength(UPCOMING_LIMIT);
  });
});

describe("ce qui exige une action", () => {
  it("remonte les échecs récents avec leur raison", () => {
    const vue = buildOverview(
      [
        publication({
          id: "rate",
          status: "failed",
          status_detail: "container_failed",
          caption: "Ma vidéo",
          scheduled_at: new Date(MAINTENANT - 2 * JOUR).toISOString(),
        }),
      ],
      [],
      options,
    );
    expect(vue.counts.failedRecently).toBe(1);
    expect(vue.attention).toEqual([
      {
        kind: "publication_failed",
        publicationId: "rate",
        platform: "facebook",
        caption: "Ma vidéo",
        detail: "container_failed",
        occurredAt: new Date(MAINTENANT - 2 * JOUR).toISOString(),
      },
    ]);
  });

  it("oublie les échecs trop anciens : l'information n'est plus actionnable", () => {
    const vue = buildOverview(
      [
        publication({
          status: "failed",
          scheduled_at: new Date(MAINTENANT - (FAILURE_WINDOW_DAYS + 1) * JOUR).toISOString(),
        }),
      ],
      [],
      options,
    );
    expect(vue.counts.failedRecently).toBe(0);
    expect(vue.attention).toEqual([]);
  });

  it("un compte inutilisable passe AVANT les échecs déjà constatés", () => {
    // Un compte révoqué bloque tout ce qui viendra ; un échec passé est
    // derrière soi. L'ordre d'affichage doit refléter cette différence.
    const vue = buildOverview(
      [
        publication({
          status: "failed",
          scheduled_at: new Date(MAINTENANT - JOUR).toISOString(),
        }),
      ],
      [compte({ status: "revoked", display_name: "Page morte" })],
      options,
    );
    expect(vue.attention.map((a) => a.kind)).toEqual([
      "account_unusable",
      "publication_failed",
    ]);
    const premier = vue.attention[0];
    if (premier.kind !== "account_unusable") throw new Error("ordre inattendu");
    expect(premier.label).toBe("Page morte");
    expect(premier.status).toBe("revoked");
  });

  it("un jeton expiré sans moyen de le renouveler est signalé", () => {
    const vue = buildOverview(
      [],
      [
        compte({
          status: "active",
          can_refresh: false,
          token_expires_at: new Date(MAINTENANT - JOUR).toISOString(),
        }),
      ],
      options,
    );
    // `effectiveStatus` le voit expiré même si la colonne dit « active ».
    expect(vue.attention).toHaveLength(1);
    expect(vue.attention[0].kind).toBe("account_unusable");
  });

  it("rien à signaler : la liste est vide, pas remplie de bruit", () => {
    const vue = buildOverview(
      [
        publication({ status: "published", published_at: new Date(MAINTENANT).toISOString() }),
        publication({ status: "scheduled", scheduled_at: new Date(MAINTENANT + JOUR).toISOString() }),
        // Une publication ANNULÉE est un choix de l'utilisateur : elle n'a
        // rien à faire dans « à traiter ».
        publication({ status: "canceled", scheduled_at: new Date(MAINTENANT - JOUR).toISOString() }),
        // Une publication en cours se résout toute seule.
        publication({ status: "pending", scheduled_at: new Date(MAINTENANT - 60_000).toISOString() }),
      ],
      [compte(), compte({ platform: "instagram" })],
      options,
    );
    expect(vue.attention).toEqual([]);
    expect(vue.counts.failedRecently).toBe(0);
  });
});

describe("workspace vierge", () => {
  it("ne compte rien et ne signale rien", () => {
    const vue = buildOverview([], [], options);
    expect(vue.counts).toEqual({
      publishedToday: 0,
      upcoming: 0,
      publishedThisMonth: 0,
      failedRecently: 0,
    });
    expect(vue.attention).toEqual([]);
    expect(vue.upcoming).toEqual([]);
  });
});
