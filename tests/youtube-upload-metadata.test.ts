/**
 * Métadonnées d'upload YouTube — validation serveur et trajet saisie → envoi.
 *
 * AUCUNE BASE N'EST TOUCHÉE ICI. Le client Supabase est une doublure : ces
 * tests portent sur des règles, pas sur du SQL. Les invariants de persistance
 * réelle relèvent de `tests/integration/`, qui exige des identifiants.
 *
 * CE QUE CE FICHIER EXISTE POUR PROUVER
 *
 *   1. Les quatre déclarations exigées par YouTube sont contrôlées CÔTÉ
 *      SERVEUR. Le formulaire fait les mêmes contrôles, mais une requête
 *      forgée à la main ne passe pas par lui.
 *
 *   2. Une absence de réponse à « Made for Kids » est un REFUS, jamais un
 *      `false` implicite. C'est la seule règle de ce fichier qui engage la
 *      responsabilité de l'utilisateur au titre de la COPPA, et c'est
 *      exactement celle qu'un `=== "yes"` distrait ferait sauter.
 *
 *   3. Ce qui est choisi à la SAISIE est ce qui part à l'EXÉCUTION. Une
 *      publication programmée ne redemande rien à personne : elle relit ses
 *      propres déclarations. Le titre, lui, n'était pas même conservé — une
 *      publication YouTube programmée échouait sur `title_required`.
 */
import { describe, expect, it } from "vitest";

import {
  YOUTUBE_PRIVACY_STATUSES,
  YOUTUBE_TITLE_MAX_LENGTH,
  isYouTubePrivacyStatus,
  parseYouTubeMetadata,
  readStoredYouTubeMetadata,
} from "@/lib/youtube-metadata";

/** Horloge figée : l'horodatage de certification doit être vérifiable. */
const INSTANT = Date.parse("2026-09-02T15:00:00.000Z");
const horloge = () => INSTANT;

/** Une saisie complète et valide, dont chaque test retire une pièce. */
const COMPLET = {
  title: "POSTYNC — upload verification",
  privacyStatus: "private",
  madeForKids: false,
  guidelinesAcknowledged: true,
} as const;

describe("vocabulaire des visibilités", () => {
  it("offre exactement les trois valeurs imposées par la RMF", () => {
    // « Users must be able to choose whether the uploaded video will be
    // public, private, or unlisted. » Ni plus — un quatrième mot serait
    // refusé par Google — ni moins.
    expect([...YOUTUBE_PRIVACY_STATUSES].sort()).toEqual(["private", "public", "unlisted"]);
  });

  it("rejette tout ce qui n'en fait pas partie", () => {
    for (const valeur of ["Private", "PUBLIC", "hidden", "", null, undefined, 3, true]) {
      expect(isYouTubePrivacyStatus(valeur)).toBe(false);
    }
  });
});

describe("validation à la saisie", () => {
  it("accepte une saisie complète et horodate la certification", () => {
    const resultat = parseYouTubeMetadata(COMPLET, horloge);
    expect(resultat).toEqual({
      ok: true,
      value: {
        title: "POSTYNC — upload verification",
        privacyStatus: "private",
        madeForKids: false,
        guidelinesAcknowledgedAt: "2026-09-02T15:00:00.000Z",
      },
    });
  });

  it("rogne le titre, et un titre d'espaces n'est pas un titre", () => {
    const espaces = parseYouTubeMetadata({ ...COMPLET, title: "   " }, horloge);
    expect(espaces).toMatchObject({ ok: false, code: "youtube_title_required" });

    const rogne = parseYouTubeMetadata({ ...COMPLET, title: "  Titre  " }, horloge);
    expect(rogne).toMatchObject({ ok: true, value: { title: "Titre" } });
  });

  it("accepte 100 caractères pile, refuse 101", () => {
    const pile = parseYouTubeMetadata(
      { ...COMPLET, title: "a".repeat(YOUTUBE_TITLE_MAX_LENGTH) },
      horloge,
    );
    expect(pile.ok).toBe(true);

    const trop = parseYouTubeMetadata(
      { ...COMPLET, title: "a".repeat(YOUTUBE_TITLE_MAX_LENGTH + 1) },
      horloge,
    );
    expect(trop).toMatchObject({ ok: false, code: "youtube_title_too_long" });
  });

  it.each(YOUTUBE_PRIVACY_STATUSES)("accepte la visibilité %s telle quelle", (choix) => {
    expect(parseYouTubeMetadata({ ...COMPLET, privacyStatus: choix }, horloge)).toMatchObject({
      ok: true,
      value: { privacyStatus: choix },
    });
  });

  it("refuse une visibilité absente ou inventée, sans lui substituer un défaut", () => {
    for (const valeur of [null, undefined, "", "hidden", "PRIVATE"]) {
      expect(parseYouTubeMetadata({ ...COMPLET, privacyStatus: valeur }, horloge)).toMatchObject({
        ok: false,
        code: "youtube_privacy_invalid",
      });
    }
  });

  it("SANS RÉPONSE sur Made for Kids, c'est un refus — jamais un false implicite", () => {
    // LE test de ce fichier. Déclarer « non destiné aux enfants » à la place
    // de quelqu'un engagerait sa responsabilité, et la nôtre au titre de
    // III.J. `null` et `undefined` doivent donc échouer, là où `false` passe.
    for (const valeur of [null, undefined]) {
      expect(parseYouTubeMetadata({ ...COMPLET, madeForKids: valeur }, horloge)).toMatchObject({
        ok: false,
        code: "youtube_made_for_kids_required",
      });
    }
    expect(parseYouTubeMetadata({ ...COMPLET, madeForKids: false }, horloge).ok).toBe(true);
    expect(parseYouTubeMetadata({ ...COMPLET, madeForKids: true }, horloge)).toMatchObject({
      ok: true,
      value: { madeForKids: true },
    });
  });

  it("refuse une certification Community Guidelines absente ou fausse", () => {
    for (const valeur of [null, undefined, false]) {
      expect(
        parseYouTubeMetadata({ ...COMPLET, guidelinesAcknowledged: valeur }, horloge),
      ).toMatchObject({ ok: false, code: "youtube_guidelines_required" });
    }
  });

  it("signale le PREMIER manque, dans l'ordre où l'utilisateur remplit", () => {
    // Un formulaire qui dénoncerait la dernière erreur ferait remonter la
    // personne de bas en haut.
    const vide = parseYouTubeMetadata(
      { title: null, privacyStatus: null, madeForKids: null, guidelinesAcknowledged: null },
      horloge,
    );
    expect(vide).toMatchObject({ ok: false, code: "youtube_title_required" });
  });
});

describe("relecture d'une publication programmée", () => {
  /** Ce que la base rend pour une ligne programmée avec cette PR. */
  const LIGNE = {
    title: "Titre programmé",
    privacy_status: "unlisted",
    made_for_kids: true,
    guidelines_acknowledged_at: "2026-09-02T14:59:00.000Z",
  };

  it("rend EXACTEMENT ce qui a été choisi à la saisie", () => {
    // L'invariant central : ce qui part à l'exécution est ce que la personne
    // avait choisi, sans réinterprétation par le planificateur.
    expect(readStoredYouTubeMetadata(LIGNE)).toEqual({
      ok: true,
      value: {
        title: "Titre programmé",
        privacyStatus: "unlisted",
        madeForKids: true,
        // L'horodatage rendu est celui de la SAISIE, pas celui de la reprise.
        guidelinesAcknowledgedAt: "2026-09-02T14:59:00.000Z",
      },
    });
  });

  it("refuse une ligne YouTube antérieure à cette fonctionnalité", () => {
    // Les colonnes sont nullables et aucune contrainte ne les impose encore en
    // base : une ligne programmée avant cette PR n'en porte aucune. La mettre
    // en échec est le seul comportement honnête — fabriquer des déclarations à
    // la place de son auteur ne l'est pas.
    const historique = {
      title: null,
      privacy_status: null,
      made_for_kids: null,
      guidelines_acknowledged_at: null,
    };
    expect(readStoredYouTubeMetadata(historique)).toMatchObject({
      ok: false,
      code: "youtube_title_required",
    });
  });

  it("refuse une ligne dont la certification manque, même titre et visibilité présents", () => {
    expect(
      readStoredYouTubeMetadata({ ...LIGNE, guidelines_acknowledged_at: null }),
    ).toMatchObject({ ok: false, code: "youtube_guidelines_required" });
  });

  it("refuse une ligne sans déclaration Made for Kids", () => {
    expect(readStoredYouTubeMetadata({ ...LIGNE, made_for_kids: null })).toMatchObject({
      ok: false,
      code: "youtube_made_for_kids_required",
    });
  });
});

describe("aller-retour saisie → base → exécution", () => {
  it("les quatre valeurs survivent au passage par les colonnes", () => {
    // Ce test relie les deux fonctions : ce que `parseYouTubeMetadata` accepte
    // à la saisie doit ressortir identique de `readStoredYouTubeMetadata`
    // après un aller-retour par la forme des colonnes SQL.
    const saisie = parseYouTubeMetadata(
      {
        title: "Aller-retour",
        privacyStatus: "public",
        madeForKids: true,
        guidelinesAcknowledged: true,
      },
      horloge,
    );
    expect(saisie.ok).toBe(true);
    if (!saisie.ok) return;

    const colonnes = {
      title: saisie.value.title,
      privacy_status: saisie.value.privacyStatus,
      made_for_kids: saisie.value.madeForKids,
      guidelines_acknowledged_at: saisie.value.guidelinesAcknowledgedAt,
    };

    const relu = readStoredYouTubeMetadata(colonnes);
    expect(relu).toEqual({ ok: true, value: saisie.value });
  });
});
