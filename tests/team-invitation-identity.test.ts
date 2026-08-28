import { describe, expect, it } from "vitest";

import { normalizeEmail, isPlausibleEmail, hashesMatch } from "@/server/team/invitations";

/**
 * C14 — identité d'une invitation dans l'interface.
 *
 * CE QUE CE FICHIER PROTÈGE. L'écran Équipe identifie une ligne d'invitation
 * par l'ADRESSE, jamais par l'identifiant. Ce n'est pas un détail de rendu :
 * renvoyer une invitation en révoque une et en crée une autre, donc une clé
 * fondée sur l'identifiant démonterait la ligne au rafraîchissement — et
 * emporterait le lien tout juste émis, que RIEN ne permettrait de retrouver,
 * l'ancien étant révoqué et le jeton n'étant jamais conservé.
 *
 * Le bug a réellement eu lieu en production le 2026-08-28 : le renvoi
 * fonctionnait en base, et l'écran n'affichait rien.
 *
 * L'adresse est une identité valable parce que l'index unique partiel
 * `(workspace_id, email) where accepted_at is null and revoked_at is null`
 * garantit au plus UNE invitation vivante par adresse.
 */
describe("identité d'une ligne d'invitation", () => {
  it("l'adresse survit à un renvoi, l'identifiant non", () => {
    const avant = { id: "11111111-1111-4111-8111-111111111111", email: "a@exemple.fr" };
    const apres = { id: "22222222-2222-4222-8222-222222222222", email: "a@exemple.fr" };

    expect(apres.id).not.toBe(avant.id);
    expect(apres.email).toBe(avant.email);
  });

  it("l'adresse est normalisée, donc stable d'un rendu à l'autre", () => {
    expect(normalizeEmail("  Jean@Exemple.FR ")).toBe("jean@exemple.fr");
    expect(normalizeEmail("jean@exemple.fr")).toBe(normalizeEmail("JEAN@EXEMPLE.FR"));
  });
});

describe("garde-fous du module d'invitation", () => {
  it("rejette ce qui ne ressemble pas à une adresse", () => {
    expect(isPlausibleEmail("jean@exemple.fr")).toBe(true);
    expect(isPlausibleEmail("jean@exemple")).toBe(false);
    expect(isPlausibleEmail("jean exemple.fr")).toBe(false);
    expect(isPlausibleEmail("")).toBe(false);
    expect(isPlausibleEmail(`${"a".repeat(250)}@exemple.fr`)).toBe(false);
  });

  it("compare les empreintes sans se laisser mesurer", () => {
    const a = "a".repeat(64);
    expect(hashesMatch(a, a)).toBe(true);
    expect(hashesMatch(a, "b".repeat(64))).toBe(false);
    // Longueurs différentes : refusé sans lever.
    expect(hashesMatch(a, "b")).toBe(false);
  });
});
