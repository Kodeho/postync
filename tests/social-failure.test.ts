/**
 * C10.2b — quand faut-il cesser d'afficher un compte comme « Connecté » ?
 *
 * Les cas de ce fichier ne sont pas inventés : ce sont ceux réellement
 * rencontrés en production. Deux erreurs symétriques sont possibles, et la
 * seconde est la plus grave :
 *
 *   * ne PAS déclasser un compte dont le jeton est mort → la publication
 *     échoue chaque nuit et l'interface prétend que tout va bien ;
 *   * déclasser un compte parfaitement valide → on envoie le propriétaire
 *     reconnecter des comptes qui n'ont aucun problème, ce qui n'y changera
 *     rien et détruit la confiance dans l'indicateur.
 *
 * D'où la règle éprouvée ici : dans le doute, on ne touche à rien.
 */
import { describe, expect, it } from "vitest";

import { classifyFailure, requiresReconnect } from "@/server/social/failure";

describe("autorisation réellement invalide", () => {
  it("Meta : OAuthException/190 signifie que le jeton n'est plus valable", () => {
    // Forme exacte produite par `metaErrorCode` : type/code/sous-code.
    expect(classifyFailure("facebook video_reels start: HTTP 400 OAuthException/190")).toBe(
      "auth_revoked",
    );
    // 458 (application retirée), 460 (mot de passe changé), 463 (expiré),
    // 467 (invalide) relèvent tous du code 190.
    for (const sousCode of [458, 460, 463, 467]) {
      expect(
        classifyFailure(`facebook rupload: HTTP 400 OAuthException/190/${sousCode}`),
        `sous-code ${sousCode}`,
      ).toBe("auth_revoked");
    }
  });

  it("Google et TikTok : réponses standard du serveur d'autorisation", () => {
    expect(classifyFailure("google refresh: HTTP 400 invalid_grant")).toBe("auth_revoked");
    expect(classifyFailure("google token: HTTP 401 invalid_token")).toBe("auth_revoked");
    expect(classifyFailure("tiktok refresh: invalid_grant")).toBe("auth_revoked");
    expect(classifyFailure("tiktok user/info: access_token_invalid")).toBe("auth_revoked");
  });

  it("`requiresReconnect` est le raccourci de lecture", () => {
    expect(requiresReconnect("facebook: HTTP 400 OAuthException/190/463")).toBe(true);
    expect(requiresReconnect("facebook: HTTP 503")).toBe(false);
    expect(requiresReconnect(null)).toBe(false);
    expect(requiresReconnect("")).toBe(false);
  });
});

describe("ce qui NE doit PAS déclasser un compte", () => {
  it("blocage au niveau de l'APPLICATION : les comptes sont sains", () => {
    // Vécu le 2026-08-27 : les deux apps Meta étaient bloquées, tous les
    // appels renvoyaient OAuthException/200 « API access blocked. » alors que
    // les autorisations des comptes étaient intactes — la preuve étant que
    // tout est reparti sans aucune reconnexion, une fois le compte Meta
    // vérifié. Déclasser aurait été un contresens.
    expect(classifyFailure("facebook video_reels start: HTTP 400 OAuthException/200")).toBe(
      "other",
    );
    expect(requiresReconnect("facebook: HTTP 400 OAuthException/200")).toBe(false);
  });

  it("pannes de plateforme et limitations de débit", () => {
    for (const detail of [
      "facebook rupload: HTTP 500",
      "instagram media_publish: HTTP 502",
      "google refresh: HTTP 503",
      "tiktok token: HTTP 429",
      "facebook: HTTP 400 OAuthException/4",
      "facebook: HTTP 400 OAuthException/17",
      "facebook: HTTP 400 OAuthException/32",
      "facebook: HTTP 400 OAuthException/613",
      "instagram: rate limit reached",
      "facebook rupload: timeout",
    ]) {
      expect(classifyFailure(detail), detail).toBe("temporary");
    }
  });

  it("un 5xx accompagné d'un texte trompeur reste passager", () => {
    // L'ordre des règles compte : le signal passager est évalué EN PREMIER.
    // Sans cela, une panne de plateforme dont le corps mentionne
    // « invalid_grant » forcerait une reconnexion inutile.
    expect(classifyFailure("google refresh: HTTP 503 invalid_grant")).toBe("temporary");
  });

  it("refus métier : le compte n'y est pour rien", () => {
    expect(classifyFailure("caption_too_long")).toBe("other");
    expect(classifyFailure("container_failed")).toBe("other");
    expect(classifyFailure("media_incompatible")).toBe("other");
    expect(classifyFailure("provider_error")).toBe("other");
  });

  it("un nombre contenant 190 n'est pas une révocation", () => {
    // L'ancienne détection cherchait `190` N'IMPORTE OÙ dans le message :
    // un identifiant de conteneur ou de Page suffisait à faire croire à une
    // révocation et à déconnecter un compte sain.
    expect(classifyFailure("facebook container 1190234: HTTP 400")).toBe("other");
    expect(classifyFailure("facebook page 1297015590161301: HTTP 400")).toBe("other");
    expect(classifyFailure("facebook: HTTP 400 OAuthException/1900")).toBe("other");
  });

  it("détail absent ou vide : aucune conclusion", () => {
    expect(classifyFailure(null)).toBe("other");
    expect(classifyFailure(undefined)).toBe("other");
    expect(classifyFailure("")).toBe("other");
  });
});
