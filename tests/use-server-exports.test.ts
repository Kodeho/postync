/**
 * Un module `"use server"` ne peut exporter QUE des fonctions asynchrones.
 *
 * POURQUOI CE TEST EXISTE. Next.js transforme chaque export d'un fichier
 * `"use server"` en point d'entrée appelable depuis le client. Un objet, une
 * constante ou une classe n'en est pas un — et la règle n'est PAS vérifiée à
 * la compilation. Elle l'est au chargement du module, en production.
 *
 * Le 2026-09-01, `features/legal/accept-action.ts` exportait un objet d'état
 * aux côtés de son action. `tsc`, ESLint, `next build` et 693 tests passaient.
 * La première soumission du formulaire en production a rendu `500` :
 *
 *     A "use server" file can only export async functions, found object.
 *
 * La garde de réacceptation redirigeant tout le monde vers ce formulaire, plus
 * aucun compte ne pouvait entrer. Il a fallu restaurer le déploiement
 * précédent. Ce test rend cette classe d'erreur impossible à réintroduire.
 *
 * L'analyse est SYNTAXIQUE — le fichier est lu, pas importé : importer un
 * module serveur depuis un test exigerait tout son environnement, et le test
 * cesserait de porter sur ce qu'il doit vérifier.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Tous les fichiers `.ts`/`.tsx` de `src/`, récursivement. */
function sources(racine: string, acc: string[] = []): string[] {
  for (const entree of readdirSync(racine)) {
    const chemin = join(racine, entree);
    if (statSync(chemin).isDirectory()) {
      sources(chemin, acc);
    } else if (/\.tsx?$/.test(entree)) {
      acc.push(chemin);
    }
  }
  return acc;
}

const RACINE = join(process.cwd(), "src");

const MODULES_SERVEUR = sources(RACINE).filter((f) => {
  const debut = readFileSync(f, "utf8").slice(0, 200);
  return /^\s*["']use server["']/.test(debut);
});

describe("modules « use server »", () => {
  it("le dépôt en contient, sinon ce test ne garde rien", () => {
    // Sans cette vérification, un changement d'organisation pourrait vider la
    // liste et rendre les assertions suivantes silencieusement inutiles.
    expect(MODULES_SERVEUR.length).toBeGreaterThanOrEqual(5);
  });

  it.each(MODULES_SERVEUR.map((f) => [f.replace(RACINE, "src").replace(/\\/g, "/"), f]))(
    "%s n'exporte que des fonctions asynchrones",
    (nom, chemin) => {
      const source = readFileSync(chemin, "utf8");

      // Ce qui est autorisé : `export async function …`, et les exports de
      // TYPES, effacés à la compilation donc invisibles à l'exécution.
      const interdits: string[] = [];

      for (const ligne of source.split(/\r?\n/)) {
        const t = ligne.trim();
        if (!t.startsWith("export")) continue;
        // Types et interfaces : effacés, sans effet à l'exécution.
        if (/^export\s+(type|interface)\b/.test(t)) continue;
        // Le cas légitime.
        if (/^export\s+async\s+function\b/.test(t)) continue;
        // Réexport de types uniquement.
        if (/^export\s+type\s*\{/.test(t)) continue;
        interdits.push(t.slice(0, 80));
      }

      expect(
        interdits,
        `${nom} exporte autre chose qu'une fonction asynchrone :\n  ${interdits.join("\n  ")}`,
      ).toEqual([]);
    },
  );
});
