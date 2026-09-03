/**
 * Garde-fou : l'interface ne doit JAMAIS promettre que YouTube rabat les
 * envois en privé.
 *
 * POURQUOI CE FICHIER EXISTE. Deux affirmations successives ont été écrites
 * dans ce dépôt, et les deux étaient fausses :
 *
 *   1. « demander autre chose que `private` produit un refus » — la
 *      documentation dit « restricted to », pas « rejected » ;
 *   2. « YouTube ramène tout envoi à la visibilité privée tant que le projet
 *      n'est pas audité » — démentie par la mesure.
 *
 * LA MESURE. Le 2026-09-02, depuis le projet `71307782821` NON audité pour
 * les scopes YouTube, un envoi demandant `public` a produit la vidéo
 * `F8tUy20bY9s`, réellement publique : oEmbed anonyme HTTP 200 et page
 * accessible sans session, là où deux vidéos envoyées en `private`
 * répondaient 403. Après passage manuel en privé, la même vidéo est repassée
 * à 403 et `LOGIN_REQUIRED`. Le contrôle était donc bien celui de la
 * visibilité demandée, pas un artefact.
 *
 * CE QUE CE FICHIER PROTÈGE. La seconde affirmation est la plus coûteuse : un
 * avertissement qui promet un filet inexistant est pire que pas
 * d'avertissement du tout, parce qu'il pousse à choisir « Publique » en se
 * croyant protégé. Ces tests échouent si cette promesse revient dans le
 * formulaire.
 *
 * Ils lisent la SOURCE plutôt que le rendu : la formulation est ici le sujet,
 * et un test de rendu passerait à côté d'un commentaire trompeur.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { YOUTUBE_PRIVACY_STATUSES } from "@/lib/youtube-metadata";

const FORMULAIRE = readFileSync(
  resolve(process.cwd(), "src/features/publish/broadcast-form.tsx"),
  "utf8",
);

const PUBLISHER = readFileSync(
  resolve(process.cwd(), "src/server/social/providers/youtube-publisher.ts"),
  "utf8",
);

describe("le formulaire ne promet aucun filet de sécurité", () => {
  /**
   * Formulations interdites. Elles décrivent toutes la même idée fausse :
   * « quoi que vous choisissiez, YouTube protégera la vidéo ».
   */
  const INTERDITES: { motif: RegExp; description: string }[] = [
    { motif: /ram[èe]ne\s+(tout\s+)?envoi/i, description: "« ramène tout envoi »" },
    { motif: /rabat\s+la\s+visibilit/i, description: "« rabat la visibilité »" },
    { motif: /rabattu[e]?\s+(en|sur)\s+priv/i, description: "« rabattu en privé »" },
    { motif: /forc[ée]e?\s+(en|à|a)\s+priv/i, description: "« forcée en privé »" },
    { motif: /verrouill\w*\s+en\s+priv/i, description: "« verrouillée en privé »" },
    { motif: /toujours\s+publi[ée]e?\s+en\s+priv/i, description: "« toujours publiée en privé »" },
    {
      motif: /aucune\s+autre\s+visibilit[ée]\s+n'?est\s+possible/i,
      description: "« aucune autre visibilité n'est possible »",
    },
  ];

  it.each(INTERDITES)("ne contient pas $description", ({ motif }) => {
    expect(FORMULAIRE).not.toMatch(motif);
  });

  it("n'affirme nulle part qu'une visibilité serait refusée par Google", () => {
    // La première version du mensonge. Formulée autrement, elle reviendrait
    // au même : décourager le choix au lieu de le décrire.
    expect(FORMULAIRE).not.toMatch(/produit\s+un\s+refus/i);
    expect(FORMULAIRE).not.toMatch(/refus\w*\s+par\s+YouTube/i);
  });
});

describe("le formulaire dit ce que POSTYNC fait réellement", () => {
  it("annonce que la visibilité choisie est transmise EXACTEMENT", () => {
    // C'est la seule promesse que le code tient. Elle doit être écrite.
    expect(FORMULAIRE).toMatch(/transmet\s+à\s+YouTube\s+<strong>exactement<\/strong>/);
  });

  it("décrit les trois visibilités, chacune par ce qui la distingue", () => {
    // Publique : l'immédiateté. Non répertoriée : le lien. Privée : les
    // règles de YouTube. Un libellé seul ne suffirait pas à choisir.
    expect(FORMULAIRE).toMatch(/Visible imm[ée]diatement par tous/i);
    expect(FORMULAIRE).toMatch(/Accessible à toute personne poss[ée]dant le lien/i);
    expect(FORMULAIRE).toMatch(/r[èe]gles de confidentialit[ée] de YouTube/i);
  });

  it("propose les trois valeurs, ni plus ni moins", () => {
    for (const valeur of YOUTUBE_PRIVACY_STATUSES) {
      expect(FORMULAIRE).toContain(`VISIBILITES[valeur]`);
      expect(FORMULAIRE).toMatch(new RegExp(`${valeur}:\\s*\\{`));
    }
    expect(YOUTUBE_PRIVACY_STATUSES).toHaveLength(3);
  });
});

describe("le publisher n'impose aucune visibilité", () => {
  it("ne contient aucune constante figeant `private` comme valeur envoyée", () => {
    // `PRIVACY_STATUS_FALLBACK` subsiste comme repli d'un appel interne
    // oublieux, mais rien ne doit réécrire une valeur reçue.
    expect(PUBLISHER).not.toMatch(/privacyStatus:\s*"(private|public|unlisted)"/);
    expect(PUBLISHER).toMatch(/privacyStatus:\s*input\.privacyLevel/);
  });

  it("garde la trace de la mesure qui a démenti l'affirmation", () => {
    // Le commentaire n'est pas décoratif : sans lui, la troisième version de
    // l'erreur s'écrira. Il cite la vidéo et la date.
    expect(PUBLISHER).toContain("F8tUy20bY9s");
    expect(PUBLISHER).toMatch(/2026-09-02/);
  });
});
