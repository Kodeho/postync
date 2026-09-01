/**
 * Acceptation des documents légaux — ce qui se vérifie sans base.
 *
 * Les tests qui exigent la table `legal_acceptances` vivent dans
 * `tests/integration/legal-acceptance.test.ts` : ils ne peuvent pas s'exécuter
 * tant que la migration n'est pas appliquée. Ce fichier-ci couvre tout le
 * reste — validation serveur, versions, et absence de dark pattern dans le
 * balisage —, et il tourne dès maintenant.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LEGAL_LAST_UPDATED, PRIVACY_VERSION, TERMS_VERSION } from "@/config/legal";
import { validateSignup } from "@/features/auth/validation";

const lire = (chemin: string) => readFileSync(join(process.cwd(), chemin), "utf8");

function formulaire(entrees: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(entrees)) data.set(k, v);
  return data;
}

const VALIDE = {
  displayName: "Camille Martin",
  email: "camille@example.com",
  password: "motdepasse-solide",
  confirmPassword: "motdepasse-solide",
};

describe("versions légales", () => {
  it("sont au format date, lisible en base comme dans un échange", () => {
    for (const v of [TERMS_VERSION, PRIVACY_VERSION]) {
      expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("sont deux valeurs distinctes, modifiables séparément", () => {
    // Elles peuvent être égales aujourd'hui ; ce qui compte est qu'elles
    // soient deux constantes, pour qu'une correction des CGU n'invalide pas
    // l'acceptation de la politique.
    const source = lire("src/config/legal.ts");
    expect(source).toMatch(/export const TERMS_VERSION = /);
    expect(source).toMatch(/export const PRIVACY_VERSION = /);
  });

  it("la date affichée dérive des versions, elle ne peut pas diverger", () => {
    expect(LEGAL_LAST_UPDATED).toBe(
      TERMS_VERSION >= PRIVACY_VERSION ? TERMS_VERSION : PRIVACY_VERSION,
    );
    expect(lire("src/config/legal.ts")).not.toMatch(/LEGAL_LAST_UPDATED = "\d{4}/);
  });
});

describe("validation serveur de l'inscription", () => {
  it("REFUSE une inscription sans acceptation", () => {
    // Cas du contournement client : le champ est simplement absent, comme
    // lorsqu'on poste le formulaire directement ou qu'on retire l'attribut
    // `required` dans la console.
    const r = validateSignup(formulaire(VALIDE));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/accepter les conditions/i);
  });

  it("REFUSE une valeur forgée qui n'est pas celle d'une case cochée", () => {
    for (const valeur of ["", "false", "0", "off", "true", "oui"]) {
      const r = validateSignup(formulaire({ ...VALIDE, legalAccepted: valeur }));
      expect(r.ok, `valeur « ${valeur} »`).toBe(false);
    }
  });

  it("accepte lorsque la case est réellement cochée", () => {
    const r = validateSignup(formulaire({ ...VALIDE, legalAccepted: "on" }));
    expect(r.ok).toBe(true);
  });

  it("ne contourne pas les autres règles : un mot de passe court reste refusé", () => {
    const r = validateSignup(
      formulaire({ ...VALIDE, password: "court", confirmPassword: "court", legalAccepted: "on" }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("le formulaire ne comporte aucun dark pattern", () => {
  const INSCRIPTION = lire("src/features/auth/signup-form.tsx");
  const REACCEPTATION = lire("src/features/legal/accept-form.tsx");

  it("la case n'est jamais pré-cochée", () => {
    for (const [nom, source] of [
      ["inscription", INSCRIPTION],
      ["réacceptation", REACCEPTATION],
    ] as const) {
      expect(source, nom).toMatch(/name="legalAccepted"/);
      expect(source, nom).not.toMatch(/defaultChecked/);
      expect(source, nom).not.toMatch(/checked={true}/);
    }
  });

  it("la case est obligatoire et reliée à son libellé", () => {
    for (const source of [INSCRIPTION, REACCEPTATION]) {
      expect(source).toMatch(/required/);
      expect(source).toMatch(/id="legalAccepted"/);
      expect(source).toMatch(/htmlFor="legalAccepted"/);
      // Le texte d'aide est annoncé aux lecteurs d'écran, pas seulement affiché.
      expect(source).toMatch(/aria-describedby="legalAccepted-aide"/);
    }
  });

  it("les deux documents sont liés, et s'ouvrent SANS faire perdre la saisie", () => {
    for (const source of [INSCRIPTION, REACCEPTATION]) {
      expect(source).toMatch(/href="\/terms"/);
      expect(source).toMatch(/href="\/privacy"/);
      // Deux liens, deux `target="_blank"` : naviguer dans le même onglet
      // effacerait le mot de passe déjà saisi, et l'utilisateur renoncerait à
      // lire plutôt qu'à tout ressaisir.
      expect((source.match(/target="_blank"/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect((source.match(/rel="noopener noreferrer"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("l'écran de réacceptation laisse toutes les issues ouvertes", () => {
  const ECRAN = lire("src/app/legal/accept/page.tsx");

  it("propose les deux documents, la déconnexion et la suppression du compte", () => {
    expect(ECRAN).toMatch(/href="\/terms"/);
    expect(ECRAN).toMatch(/href="\/privacy"/);
    expect(ECRAN).toMatch(/signOutAction/);
    expect(ECRAN).toMatch(/Se déconnecter/);
    expect(ECRAN).toMatch(/suppression\s*\n?\s*complète de votre compte/);
  });

  it("n'appelle PAS la garde : ce serait une boucle de redirection", () => {
    expect(ECRAN).not.toMatch(/requireLegalAcceptance/);
  });
});

describe("les traitements serveur planifiés ne sont pas concernés", () => {
  it("le planificateur ne consulte jamais l'acceptation", () => {
    // Une publication programmée hier doit partir aujourd'hui, même si son
    // auteur doit réaccepter : suspendre un envoi pour un motif documentaire
    // ferait rater une échéance à un client sans le prévenir.
    for (const fichier of [
      "src/server/social/scheduler.ts",
      "src/server/social/publish.ts",
      "src/app/api/cron/publish/route.ts",
    ]) {
      const source = lire(fichier);
      expect(source, fichier).not.toMatch(/legal_acceptances/);
      expect(source, fichier).not.toMatch(/requireLegalAcceptance|hasAcceptedCurrentLegalVersions/);
    }
  });
});
