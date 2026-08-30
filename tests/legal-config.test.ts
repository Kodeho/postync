/**
 * Prérequis de mise en production — cohérence des informations légales.
 *
 * Ces tests ne jugent pas la qualité juridique des textes : ils verrouillent
 * ce qui peut casser sans bruit — une mention obligatoire vide qui passerait
 * inaperçue, un transfert hors EEE annoncé sans garantie, un lien légal
 * disparu du pied de page.
 */
import { describe, expect, it } from "vitest";

import {
  HOSTING_OUTSIDE_EEA,
  HOSTING_SAFEGUARD,
  LEGAL_LAST_UPDATED,
  PUBLISHER,
  SOCIAL_RECIPIENTS,
  SUBPROCESSORS,
  VAT_NOTICE,
  missingLegalFields,
  type Publisher,
} from "@/config/legal";
import { LEGAL_LINKS } from "@/components/layout/public-footer";

const COMPLET: Publisher = {
  brand: "POSTYNC",
  legalName: "Exemple SAS",
  tradeName: "Exemple",
  legalForm: "SAS",
  shareCapital: null,
  address: "1 rue de l'Exemple, 75001 Paris",
  registration: "123 456 789 RCS Paris",
  vatNumber: null,
  publicationDirector: "Prénom Nom",
  website: "https://www.exemple.test",
  contactEmail: "contact@example.com",
};

describe("mentions obligatoires", () => {
  it("signale chaque champ obligatoire manquant, et se tait quand tout est là", () => {
    expect(missingLegalFields(COMPLET)).toEqual([]);
    expect(missingLegalFields({ ...COMPLET, address: null })).toEqual(["Adresse de l'établissement"]);
    // Une chaîne d'espaces est un blanc, pas une adresse.
    expect(missingLegalFields({ ...COMPLET, legalName: "   " })).toEqual([
      "Identité juridique de l'éditeur",
    ]);
    expect(missingLegalFields({ ...COMPLET, legalName: null, registration: null })).toHaveLength(2);
  });

  it("les documents publiés ne portent AUCUNE mention manquante", () => {
    // Tant que l'éditeur n'avait pas fourni son identité, cette assertion
    // n'aurait servi à rien. Maintenant qu'elle est renseignée, elle devient
    // le garde-fou : une régression sur `PUBLISHER` remettrait un
    // avertissement « document incomplet » en ligne, visible de tous.
    expect(missingLegalFields()).toEqual([]);
  });

  it("TVA : la mention et le numéro ne se contredisent JAMAIS", () => {
    // Deux états cohérents, et deux seulement :
    //   * franchise en base -> pas de numéro, mais la mention obligatoire ;
    //   * assujetti          -> un numéro, et pas de mention de franchise.
    // Afficher les deux, ou aucun des deux, serait une faute sur un document
    // commercial.
    const franchise = VAT_NOTICE !== null;
    const assujetti = PUBLISHER.vatNumber !== null;
    expect(franchise).not.toBe(assujetti);

    if (franchise) {
      expect(VAT_NOTICE).toMatch(/293\s*B/);
    }
  });

  it("l'adresse de contact est toujours renseignée — c'est le point d'entrée RGPD", () => {
    expect(PUBLISHER.contactEmail).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  });

  it("l'identité juridique n'est JAMAIS la marque ni le nom commercial", () => {
    // La régression corrigée le 2026-08-30 : `legalName` portait « Kodeho »,
    // qui est le nom commercial. Les mentions légales annonçaient donc un
    // éditeur qui n'existe pas au registre, et toute vérification d'identité
    // — plateforme, banque, administration — butait sur l'écart avec le Kbis.
    expect(PUBLISHER.legalName).not.toBe(PUBLISHER.brand);
    expect(PUBLISHER.legalName).not.toBe(PUBLISHER.tradeName);
  });

  it("le site de l'entreprise n'est pas celui du produit", () => {
    // Deux domaines, deux rôles : `postync.app` est le produit, le site de
    // l'éditeur est celui qui figure au registre. Les confondre recrée
    // exactement l'écart que le test précédent interdit.
    if (PUBLISHER.website !== null) {
      expect(PUBLISHER.website).toMatch(/^https:\/\//);
      expect(PUBLISHER.website).not.toContain("postync.app");
    }
  });
});

describe("sous-traitants et transferts", () => {
  it("tout transfert hors EEE est assorti d'une garantie explicite", () => {
    for (const s of SUBPROCESSORS) {
      if (s.outsideEea) {
        expect(s.safeguard, `${s.name} : transfert hors EEE sans garantie`).toBeTruthy();
      }
    }
  });

  it("les trois prestataires réellement utilisés sont déclarés", () => {
    const noms = SUBPROCESSORS.map((s) => s.name).join(" ");
    expect(noms).toContain("Supabase");
    expect(noms).toContain("Vercel");
    expect(noms).toContain("Stripe");
  });

  it("l'hébergement de l'application reste cohérent avec sa fiche", () => {
    // Si la région de déploiement change, la fiche doit changer AVEC elle :
    // c'est exactement le genre d'incohérence qu'un audit relève.
    const vercel = SUBPROCESSORS.find((s) => s.name.includes("Vercel"));
    expect(vercel).toBeDefined();
    expect(vercel!.outsideEea).toBe(HOSTING_OUTSIDE_EEA);
    expect(vercel!.safeguard).toBe(HOSTING_SAFEGUARD);
  });

  it("les réseaux sociaux ne sont PAS présentés comme des sous-traitants", () => {
    // Ils décident de l'usage ultérieur des contenus : les ranger parmi les
    // sous-traitants changerait la nature des obligations annoncées.
    const sousTraitants = SUBPROCESSORS.map((s) => s.name).join(" ");
    for (const r of SOCIAL_RECIPIENTS) {
      expect(sousTraitants).not.toContain(r.name);
    }
    expect(SOCIAL_RECIPIENTS.length).toBe(3);
  });
});

describe("accessibilité des documents", () => {
  it("les trois documents légaux sont liés depuis le pied de page public", () => {
    expect(LEGAL_LINKS.map((l) => l.href).sort()).toEqual(["/legal", "/privacy", "/terms"]);
    for (const lien of LEGAL_LINKS) {
      expect(lien.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("la date de mise à jour est une date ISO valide et pas dans le futur", () => {
    expect(LEGAL_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const date = new Date(`${LEGAL_LAST_UPDATED}T00:00:00Z`);
    expect(Number.isNaN(date.getTime())).toBe(false);
    expect(date.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
