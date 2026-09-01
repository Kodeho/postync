/**
 * Divulgations obligatoires imposées par les YouTube API Services Terms of
 * Service et les Developer Policies.
 *
 * POURQUOI CES TESTS LISENT LE SOURCE. Ce qui est exigé ici n'est pas un
 * comportement, c'est la PRÉSENCE de trois liens et d'une phrase dans deux
 * pages publiques. Leur disparition ne casserait aucun rendu, ne ferait échouer
 * aucun test métier, et ne se verrait qu'au refus de l'audit — des semaines plus
 * tard. Les figer ici est le seul moyen de rendre leur retrait bruyant.
 *
 * L'audit du 2026-09-01 avait relevé ZÉRO occurrence de ces trois liens.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const lire = (chemin: string) => readFileSync(join(process.cwd(), chemin), "utf8");

const CGU = lire("src/app/terms/page.tsx");
const CONFIDENTIALITE = lire("src/app/privacy/page.tsx");

/** Une URL présente ET rendue cliquable, pas seulement citée en commentaire. */
function lienCliquable(source: string, url: string): boolean {
  return new RegExp(`href="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(source);
}

describe("conditions d'utilisation", () => {
  it("renvoie vers les Conditions d'utilisation de YouTube", () => {
    expect(lienCliquable(CGU, "https://www.youtube.com/t/terms")).toBe(true);
  });

  it("indique que l'utilisateur est lié par ces conditions", () => {
    // La formulation peut évoluer ; le fond, non : accepter d'être lié.
    expect(CGU).toMatch(/accepte[a-z]*\s+d.apos;être lié par les/i);
    expect(CGU).toMatch(/YouTube API Services/);
  });

  it("garde le lien dans une balise ouvrant un nouvel onglet, sans fuite de référent", () => {
    const bloc = CGU.slice(CGU.indexOf("https://www.youtube.com/t/terms") - 400);
    expect(bloc).toMatch(/rel="noopener noreferrer"/);
  });
});

describe("politique de confidentialité", () => {
  it("nomme les YouTube API Services", () => {
    expect(CONFIDENTIALITE).toMatch(/YouTube API Services/);
  });

  it("renvoie vers la politique de confidentialité de Google", () => {
    expect(lienCliquable(CONFIDENTIALITE, "https://policies.google.com/privacy")).toBe(true);
  });

  it("renvoie vers les paramètres de sécurité Google permettant de révoquer l'accès", () => {
    expect(
      lienCliquable(CONFIDENTIALITE, "https://security.google.com/settings/security/permissions"),
    ).toBe(true);
  });

  it("énumère les données YouTube réellement consultées", () => {
    // Identité de la chaîne, jetons, contenu publié — et rien d'autre.
    expect(CONFIDENTIALITE).toMatch(/identifiant, nom\s*\n?\s*affiché et image de profil/);
    expect(CONFIDENTIALITE).toMatch(/jetons d.apos;autorisation/i);
  });

  it("affirme ce que nous NE lisons pas", () => {
    for (const exclu of ["autres\\s*\\n?\\s*vidéos", "statistiques", "playlists", "commentaires", "abonnés"]) {
      expect(CONFIDENTIALITE).toMatch(new RegExp(exclu));
    }
  });

  it("annonce une révocation IMMÉDIATE, conforme au code", () => {
    // `disconnectSocialAccount` appelle `provider.revoke` puis supprime la ligne,
    // et le trigger purge le coffre. Rien n'est différé : promettre autre chose
    // — « sous 30 jours », par exemple — serait faux dans les deux sens.
    // Borné à la section YouTube : « trente jours » reste EXACT ailleurs, pour
    // la suppression complète du compte, qui est une procédure manuelle par
    // courriel. Confondre les deux ferait de ce test un faux signal.
    const debut = CONFIDENTIALITE.indexOf("Retirer notre accès");
    const bloc = CONFIDENTIALITE.slice(debut, CONFIDENTIALITE.indexOf("</LegalSection>", debut));
    expect(bloc).toMatch(/immédiatement/);
    expect(bloc).not.toMatch(/trente jours|30 jours/);
  });

  it("annonce la purge de l'historique, et ne prétend PAS conserver des identifiants YouTube", () => {
    // Première rédaction de cette page : « l'historique conserve l'identifiant
    // de la chaîne et le lien des vidéos ». C'était exact au regard du code
    // d'alors — et incompatible avec l'exigence de suppression des données
    // autorisées. Le code a changé, la page aussi ; ce test empêche le retour
    // en arrière de l'un comme de l'autre.
    expect(CONFIDENTIALITE).toMatch(/purge aussi votre historique/);
    expect(CONFIDENTIALITE).not.toMatch(/conserve\s+l.apos;identifiant de la chaîne/);
    // Ce qui reste est nommé, et ne vient pas de la plateforme.
    expect(CONFIDENTIALITE).toMatch(/la date, le\s*\n?\s*statut, votre légende/);
    // La vidéo publiée, elle, appartient au client : on ne prétend pas l'effacer.
    expect(CONFIDENTIALITE).toMatch(/reste sur votre chaîne/);
  });
});

describe("accessibilité publique des divulgations", () => {
  it("les deux pages sont publiques : aucune garde d'authentification", () => {
    for (const page of [CGU, CONFIDENTIALITE]) {
      expect(page).not.toMatch(/requireAuth|redirect\("\/login"\)/);
    }
  });
});
