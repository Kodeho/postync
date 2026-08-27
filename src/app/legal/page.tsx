import type { Metadata } from "next";

import { LegalPage, LegalSection, LegalValue } from "@/components/layout/legal-page";
import { PRODUCT_NAME } from "@/config/product";
import { HOSTING_REGION_LABEL, PUBLISHER, SUBPROCESSORS } from "@/config/legal";

/**
 * Mentions légales — obligation distincte des CGU en droit français
 * (art. 6 III de la loi pour la confiance dans l'économie numérique).
 * Elles identifient l'éditeur et l'hébergeur ; les CGU régissent la relation
 * contractuelle. Les confondre reviendrait à n'en satisfaire aucune.
 */

export const metadata: Metadata = {
  title: `Mentions légales — ${PRODUCT_NAME}`,
  description: `Identité de l'éditeur et de l'hébergeur du service ${PRODUCT_NAME}.`,
};

export default function LegalNoticePage() {
  const hebergeurs = SUBPROCESSORS.filter((s) => s.role.toLowerCase().includes("hébergement"));

  return (
    <LegalPage title="Mentions légales">
      <LegalSection id="editeur" title="Éditeur du service">
        <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <dt className="text-muted">Service</dt>
          <dd>{PUBLISHER.brand}</dd>

          <dt className="text-muted">Raison sociale</dt>
          <dd>
            <LegalValue value={PUBLISHER.legalName} />
          </dd>

          <dt className="text-muted">Forme juridique</dt>
          <dd>
            <LegalValue value={PUBLISHER.legalForm} />
          </dd>

          {PUBLISHER.shareCapital ? (
            <>
              <dt className="text-muted">Capital social</dt>
              <dd>{PUBLISHER.shareCapital}</dd>
            </>
          ) : null}

          <dt className="text-muted">Siège social</dt>
          <dd>
            <LegalValue value={PUBLISHER.address} />
          </dd>

          <dt className="text-muted">Immatriculation</dt>
          <dd>
            <LegalValue value={PUBLISHER.registration} />
          </dd>

          {PUBLISHER.vatNumber ? (
            <>
              <dt className="text-muted">TVA intracommunautaire</dt>
              <dd>{PUBLISHER.vatNumber}</dd>
            </>
          ) : null}

          <dt className="text-muted">Directeur de la publication</dt>
          <dd>
            <LegalValue value={PUBLISHER.publicationDirector} />
          </dd>

          <dt className="text-muted">Contact</dt>
          <dd>
            <a
              href={`mailto:${PUBLISHER.contactEmail}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              {PUBLISHER.contactEmail}
            </a>
          </dd>
        </dl>
      </LegalSection>

      <LegalSection id="hebergement" title="Hébergement">
        <p>
          L&apos;application est hébergée par {hebergeurs.map((h) => h.name).join(", ")}, dont les
          serveurs traitant les requêtes se situent à {HOSTING_REGION_LABEL}. La base de données et
          les médias sont hébergés par Supabase, Inc. à Londres, Royaume-Uni.
        </p>
        <p className="text-muted">
          Le détail des traitements et des transferts figure dans la{" "}
          <a href="/privacy" className="text-primary underline-offset-4 hover:underline">
            politique de confidentialité
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection id="propriete" title="Propriété intellectuelle">
        <p>
          La structure du service, son code, sa charte graphique et ses textes sont protégés par le
          droit d&apos;auteur. Toute reproduction, adaptation ou diffusion, totale ou partielle, sans
          autorisation écrite préalable de l&apos;éditeur est interdite.
        </p>
        <p>
          Les contenus que vous importez ou publiez au moyen du service restent votre propriété.
          {" "}
          {PRODUCT_NAME} n&apos;acquiert sur eux aucun droit autre que celui, strictement technique,
          de les stocker et de les transmettre aux réseaux que vous désignez.
        </p>
      </LegalSection>

      <LegalSection id="marques" title="Marques de tiers">
        <p>
          Instagram et Facebook sont des marques de Meta Platforms, Inc. YouTube est une marque de
          Google LLC. TikTok est une marque de ByteDance Ltd. {PRODUCT_NAME} n&apos;est ni affilié à
          ces sociétés, ni approuvé ni sponsorisé par elles ; ces noms ne sont cités que pour
          désigner les services avec lesquels une interconnexion est proposée.
        </p>
      </LegalSection>

      <LegalSection id="signalement" title="Signalement d'un contenu">
        <p>
          Tout contenu manifestement illicite accessible par l&apos;intermédiaire du service peut
          être signalé à{" "}
          <a
            href={`mailto:${PUBLISHER.contactEmail}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {PUBLISHER.contactEmail}
          </a>
          . Le signalement gagne à préciser la nature du contenu, sa localisation et les motifs pour
          lesquels il devrait être retiré.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
