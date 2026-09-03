/**
 * Rétention et révocation des données de chaîne YouTube.
 *
 * AUCUN APPEL GOOGLE, AUCUNE BASE. Les deux fonctions de décision sont pures :
 * elles reçoivent une ligne et une horloge, et rendent un verdict. C'est là
 * que vit la politique, et c'est donc là que les tests portent. Le reste du
 * module n'est que du câblage vers `disconnect_social_account`, déjà couvert
 * par les tests de déconnexion.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUE CES TESTS PROTÈGENT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. QU'UNE PANNE NE DÉTRUISE PAS UN COMPTE VALIDE. Une plateforme en 503 et
 *    une autorisation retirée produisent le même symptôme : un appel qui
 *    échoue. Les confondre coûte dans les deux sens — purger sur un 5xx
 *    détruit un compte que l'utilisateur n'a jamais révoqué.
 *
 * 2. QUE LE PLAFOND DES 30 JOURS S'APPLIQUE MALGRÉ TOUT. « Delete OR
 *    refresh » : si le refresh échoue durablement, il reste delete. Sans ce
 *    test, un service durablement en panne laisserait indéfiniment des
 *    données qu'on n'a plus le droit de conserver.
 *
 * 3. QU'UNE RÉVOCATION CONFIRMÉE NE SOIT JAMAIS DIFFÉRÉE par le compteur
 *    d'échecs passagers.
 */
import { describe, expect, it } from "vitest";

import {
  IDENTITY_MAX_AGE_DAYS,
  IDENTITY_MAX_AGE_MS,
  IDENTITY_REFRESH_AFTER_DAYS,
  IDENTITY_REFRESH_AFTER_MS,
  decideAfterFailure,
  decideRetention,
  type RetentionAccount,
} from "@/server/social/retention";

const MAINTENANT = Date.parse("2026-09-03T12:00:00.000Z");
const JOUR = 24 * 60 * 60 * 1000;
const ilYA = (jours: number) => new Date(MAINTENANT - jours * JOUR).toISOString();

function compte(p: Partial<RetentionAccount> = {}): RetentionAccount {
  return {
    id: "acc-1",
    workspace_id: "ws-1",
    platform: "youtube",
    status: "active",
    connected_at: ilYA(1),
    identity_refreshed_at: ilYA(1),
    // Ancienne tentative : la garde d'espacement ne doit pas masquer le cas
    // que chaque test cherche à vérifier.
    identity_attempted_at: ilYA(1),
    identity_refresh_failures: 0,
    ...p,
  };
}

describe("les seuils respectent le plafond réglementaire", () => {
  it("relit bien avant les 30 jours imposés", () => {
    // III.E.4.c plafonne à 30 jours. Relire au dernier moment ne laisserait
    // aucune marge pour absorber une panne : le seuil de relecture doit être
    // franchement inférieur.
    expect(IDENTITY_REFRESH_AFTER_DAYS).toBeLessThan(IDENTITY_MAX_AGE_DAYS);
    expect(IDENTITY_MAX_AGE_DAYS).toBe(30);
    // Au moins trois semaines de marge entre la relecture et le couperet.
    expect(IDENTITY_MAX_AGE_DAYS - IDENTITY_REFRESH_AFTER_DAYS).toBeGreaterThanOrEqual(21);
  });
});

describe("décision de rétention", () => {
  it("laisse tranquille une identité fraîche", () => {
    expect(decideRetention(compte({ identity_refreshed_at: ilYA(1) }), MAINTENANT)).toEqual({
      action: "keep",
    });
  });

  it("relit dès le seuil franchi, purge au plafond", () => {
    const juste = decideRetention(
      compte({ identity_refreshed_at: new Date(MAINTENANT - IDENTITY_REFRESH_AFTER_MS).toISOString() }),
      MAINTENANT,
    );
    expect(juste).toEqual({ action: "refresh" });

    const encore = decideRetention(compte({ identity_refreshed_at: ilYA(29) }), MAINTENANT);
    expect(encore).toEqual({ action: "refresh" });

    // AU PLAFOND, ON RELIT ENCORE. « Delete OR refresh » : une identité de
    // 31 jours qui se relit sans problème n'a aucune raison d'être détruite,
    // et purger sur le seul âge transformerait un retard de NOTRE passe en
    // perte de données.
    const plafond = decideRetention(
      compte({ identity_refreshed_at: new Date(MAINTENANT - IDENTITY_MAX_AGE_MS).toISOString() }),
      MAINTENANT,
    );
    expect(plafond).toEqual({ action: "refresh" });

    const bienAuDela = decideRetention(compte({ identity_refreshed_at: ilYA(120) }), MAINTENANT);
    expect(bienAuDela).toEqual({ action: "refresh" });
  });

  it("ne purge JAMAIS pour ancienneté sans avoir essayé", () => {
    // L'invariant qui protège d'une purge auto-infligée : si la passe prend
    // du retard — saturation, cron arrêté —, les comptes vieillissent sans
    // qu'aucun n'ait été sollicité. Les détruire alors serait notre faute,
    // pas une exigence réglementaire.
    for (const jours of [30, 45, 90, 365]) {
      expect(
        decideRetention(compte({ identity_refreshed_at: ilYA(jours) }), MAINTENANT).action,
      ).toBe("refresh");
    }
  });

  it("purge immédiatement un compte déjà constaté révoqué", () => {
    // Le statut vient d'un échec de renouvellement rencontré ailleurs. On ne
    // redemande rien à la plateforme : le constat est fait.
    expect(
      decideRetention(compte({ status: "revoked", identity_refreshed_at: ilYA(0) }), MAINTENANT),
    ).toEqual({ action: "purge", reason: "revoked" });
  });

  it("se rabat sur la date de connexion quand la colonne est nulle", () => {
    // Ligne créée par du code antérieur à la migration. `connected_at` EST la
    // date de lecture de l'identité : s'en servir est exact, pas approximatif.
    expect(
      decideRetention(compte({ identity_refreshed_at: null, connected_at: ilYA(2) }), MAINTENANT),
    ).toEqual({ action: "keep" });
    expect(
      decideRetention(compte({ identity_refreshed_at: null, connected_at: ilYA(31) }), MAINTENANT),
    ).toEqual({ action: "refresh" });
  });

  it("relit plutôt que de purger quand la date est illisible", () => {
    // Une relecture inutile ne coûte qu'un appel ; une purge à tort ne se
    // répare pas. Le doute profite au compte.
    expect(
      decideRetention(compte({ identity_refreshed_at: "pas une date" }), MAINTENANT),
    ).toEqual({ action: "refresh" });
  });
});

describe("échec de relecture : panne ou révocation", () => {
  const RECENT = 2 * JOUR;

  it.each([
    "google refresh: HTTP 400 invalid_grant",
    "google token: HTTP 401 invalid_token",
  ])("purge sur un signal de révocation documenté : %s", (detail) => {
    expect(decideAfterFailure(detail, RECENT)).toEqual({ action: "purge", reason: "revoked" });
  });

  it.each([
    "google refresh: HTTP 503 ",
    "google channels: HTTP 500 backendError",
    "HTTP 429 rate limit",
    "fetch failed: timeout",
  ])("NE PURGE PAS sur un échec passager : %s", (detail) => {
    // Le test central du fichier. Un 5xx n'est pas une révocation, et
    // détruire un compte sur cette base serait irréparable.
    expect(decideAfterFailure(detail, RECENT)).toEqual({ action: "retry" });
  });

  it("un 5xx accompagné d'un texte trompeur reste passager", () => {
    // `classifyFailure` teste les signaux passagers AVANT les signaux
    // d'authentification, précisément pour ce cas.
    expect(decideAfterFailure("HTTP 503 invalid_grant", RECENT)).toEqual({ action: "retry" });
  });

  it("purge malgré tout au plafond : delete OR refresh, et le refresh a échoué", () => {
    // Une panne durable ne suspend pas III.E.4.c. Passé 30 jours sans
    // relecture réussie, la donnée doit partir.
    expect(decideAfterFailure("HTTP 503 ", IDENTITY_MAX_AGE_MS)).toEqual({
      action: "purge",
      reason: "stale",
    });
    expect(decideAfterFailure("HTTP 503 ", IDENTITY_MAX_AGE_MS - 1)).toEqual({ action: "retry" });
  });

  it("une révocation confirmée n'attend jamais le plafond", () => {
    // Le compteur d'échecs passagers ne doit pas retarder une révocation :
    // elle est constatée, elle purge, quel que soit l'âge de l'identité.
    expect(decideAfterFailure("invalid_grant", 0)).toEqual({ action: "purge", reason: "revoked" });
  });

  it("un compte Google sans chaîne est traité comme passager, pas comme révoqué", () => {
    // `identity_unavailable` ne dit rien de l'autorisation : elle peut être
    // parfaitement valide. Le plafond finira par trancher si l'état dure.
    expect(decideAfterFailure("identity_unavailable", RECENT)).toEqual({ action: "retry" });
  });
});

describe("les autres réseaux ne sont pas concernés", () => {
  it("la politique ne s'applique qu'à YouTube", async () => {
    // Le filtre vit dans la requête (`.eq("platform", "youtube")`) : on
    // vérifie qu'il est bien écrit, faute de quoi une purge s'étendrait à
    // Instagram, Facebook et TikTok — dont les règles sont différentes.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/server/social/retention.ts"), "utf8");
    expect(source).toMatch(/\.eq\("platform",\s*"youtube"\)/);
  });

  it("la purge passe par la fonction du bouton Déconnecter, pas par un DELETE maison", async () => {
    // C'est ce qui garantit que la légende, le média, les dates et le statut
    // des publications survivent : un `delete` écrit ici les emporterait.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/server/social/retention.ts"), "utf8");
    expect(source).toMatch(/rpc\("disconnect_social_account"/);
    expect(source).not.toMatch(/\.from\("social_publications"\)[\s\S]{0,80}\.delete\(/);
    expect(source).not.toMatch(/\.from\("media_assets"\)/);
  });
});
