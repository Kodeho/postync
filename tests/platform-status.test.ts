import { afterEach, describe, expect, it } from "vitest";

import { getIntegrationStatuses } from "@/server/admin/platform-status";

/**
 * État des intégrations affiché dans /admin/platform.
 *
 * CE QUE CE FICHIER PROTÈGE. Cet écran est le seul endroit de POSTYNC qui
 * parle des clés d'API. Il doit dire si elles SONT LÀ, jamais ce qu'elles
 * valent : une capture d'écran d'administration finit toujours par circuler.
 * Le test ci-dessous injecte des valeurs reconnaissables et vérifie qu'aucune
 * ne ressort, sous aucune forme — pas même tronquée.
 */

const SENTINELLES = {
  SCW_SECRET_KEY: "SENTINELLE-CLE-SECRETE-SCALEWAY",
  SCW_PROJECT_ID: "SENTINELLE-PROJET-SCALEWAY",
  STRIPE_SECRET_KEY: "SENTINELLE-CLE-STRIPE",
  META_CLIENT_SECRET: "SENTINELLE-SECRET-META",
} as const;

afterEach(() => {
  for (const nom of Object.keys(SENTINELLES)) delete process.env[nom];
  delete process.env.EMAIL_FROM_ADDRESS;
});

describe("état des intégrations", () => {
  it("ne laisse sortir aucune valeur d'environnement", () => {
    Object.assign(process.env, SENTINELLES);

    const rendu = JSON.stringify(getIntegrationStatuses());
    for (const valeur of Object.values(SENTINELLES)) {
      expect(rendu).not.toContain(valeur);
      // Ni la valeur entière, ni un fragment qui permettrait de la deviner.
      expect(rendu).not.toContain(valeur.slice(0, 8));
    }
  });

  it("ne rend que des booléens et du texte fixe", () => {
    for (const item of getIntegrationStatuses()) {
      expect(typeof item.configured).toBe("boolean");
      expect(typeof item.label).toBe("string");
      expect(typeof item.note).toBe("string");
      expect(Object.keys(item).sort()).toEqual(["configured", "key", "label", "note"]);
    }
  });

  it("sépare l'ACCÈS Scaleway de la capacité d'ENVOI", () => {
    // Les deux moitiés s'obtiennent à des moments différents : la clé dès sa
    // création, l'adresse d'expédition seulement une fois le domaine
    // authentifié. Les fondre masquerait laquelle des deux manque.
    process.env.SCW_SECRET_KEY = SENTINELLES.SCW_SECRET_KEY;
    process.env.SCW_PROJECT_ID = SENTINELLES.SCW_PROJECT_ID;

    const sansDomaine = getIntegrationStatuses();
    expect(sansDomaine.find((i) => i.key === "scaleway")?.configured).toBe(true);
    expect(sansDomaine.find((i) => i.key === "email")?.configured).toBe(false);

    process.env.EMAIL_FROM_ADDRESS = "no-reply@exemple.test";
    const avecDomaine = getIntegrationStatuses();
    expect(avecDomaine.find((i) => i.key === "email")?.configured).toBe(true);
  });
});
