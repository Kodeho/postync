import { describe, expect, it } from "vitest";

import { DEFAULT_RETURN_PATH, safeReturnPath } from "@/lib/return-path";

/**
 * Destination de retour après authentification.
 *
 * CE QUE CE FICHIER PROTÈGE. Trois surfaces font revenir quelqu'un « là où il
 * allait » : la connexion, l'inscription (C14, pour une invitation reçue hors
 * session) et `/auth/callback` (C15, pour un lien de confirmation ou de
 * réinitialisation). Les deux dernières reçoivent cette valeur depuis un
 * COURRIEL, donc de l'extérieur.
 *
 * C'est la définition même d'une redirection ouverte : rediriger vers une
 * valeur non contrôlée juste après l'ouverture d'une session, c'est-à-dire au
 * moment précis où présenter une fausse page de connexion est le plus
 * rentable. La règle est donc une LISTE BLANCHE de forme, et tout le reste
 * retombe silencieusement sur l'accueil.
 */
describe("safeReturnPath", () => {
  it("accepte un chemin interne absolu", () => {
    expect(safeReturnPath("/app")).toBe("/app");
    expect(safeReturnPath("/app/kodeho/team")).toBe("/app/kodeho/team");
    expect(safeReturnPath("/invitations/abc-123")).toBe("/invitations/abc-123");
    expect(safeReturnPath("/app?onglet=membres")).toBe("/app?onglet=membres");
  });

  it("refuse une URL absolue vers un autre site", () => {
    expect(safeReturnPath("https://exemple-malveillant.test")).toBe(DEFAULT_RETURN_PATH);
    expect(safeReturnPath("http://exemple-malveillant.test/piege")).toBe(DEFAULT_RETURN_PATH);
  });

  it("refuse les formes qui ressemblent à un chemin sans en être un", () => {
    // Protocole-relatif : le navigateur y voit un HÔTE, pas un chemin.
    expect(safeReturnPath("//exemple-malveillant.test")).toBe(DEFAULT_RETURN_PATH);
    // Certains navigateurs traitent la barre inverse comme une barre oblique.
    expect(safeReturnPath("/\\exemple-malveillant.test")).toBe(DEFAULT_RETURN_PATH);
    // Un schéma n'a rien à faire dans un chemin.
    expect(safeReturnPath("/javascript:alert(1)")).toBe(DEFAULT_RETURN_PATH);
    expect(safeReturnPath("/data:text/html,x")).toBe(DEFAULT_RETURN_PATH);
    // Chemin relatif : la base d'interprétation n'est pas maîtrisée.
    expect(safeReturnPath("app/kodeho")).toBe(DEFAULT_RETURN_PATH);
  });

  it("refuse les caractères de contrôle, qui permettent d'injecter un en-tête", () => {
    expect(safeReturnPath("/app\r\nSet-Cookie: a=b")).toBe(DEFAULT_RETURN_PATH);
    expect(safeReturnPath("/app\u0000")).toBe(DEFAULT_RETURN_PATH);
    expect(safeReturnPath("/app\u007f")).toBe(DEFAULT_RETURN_PATH);
  });

  it("refuse l'absence de valeur et les valeurs démesurées", () => {
    expect(safeReturnPath(null)).toBe(DEFAULT_RETURN_PATH);
    expect(safeReturnPath(undefined)).toBe(DEFAULT_RETURN_PATH);
    expect(safeReturnPath("")).toBe(DEFAULT_RETURN_PATH);
    expect(safeReturnPath(`/${"a".repeat(600)}`)).toBe(DEFAULT_RETURN_PATH);
  });

  it("accepte un repli explicite, pour les surfaces qui n'en veulent aucun", () => {
    // La page de connexion passe "" : sans destination, elle ne doit pas
    // fabriquer un `?next=/app` qui n'a jamais été demandé.
    expect(safeReturnPath(null, "")).toBe("");
    expect(safeReturnPath("https://exemple-malveillant.test", "")).toBe("");
  });
});
