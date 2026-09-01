import type { Metadata } from "next";

import { LegalPage, LegalSection, LegalValue } from "@/components/layout/legal-page";
import { PRODUCT_NAME } from "@/config/product";
import { PUBLISHER, VAT_NOTICE } from "@/config/legal";
import { PLANS, formatPlanPrice } from "@/config/plans";

/**
 * Conditions générales d'utilisation et de vente.
 *
 * Deux points méritent l'attention plutôt qu'un copier-coller de modèle :
 *
 * 1. POSTYNC dépend d'API de tiers qu'il ne maîtrise pas. Promettre une
 *    disponibilité de publication serait un engagement intenable : le texte
 *    dit ce qui est réellement garanti, et ce qui ne l'est pas.
 * 2. Le service est numérique et à exécution immédiate. Le droit de
 *    rétractation du consommateur ne disparaît pas pour autant : il ne peut
 *    s'éteindre que sur demande expresse ET renoncement exprès, ce que le
 *    texte expose au lieu de l'escamoter.
 */

export const metadata: Metadata = {
  title: `Conditions d'utilisation — ${PRODUCT_NAME}`,
  description: `Conditions générales d'utilisation et de vente du service ${PRODUCT_NAME}.`,
};

export default function TermsPage() {
  const gratuit = PLANS.find((p) => p.key === "free");
  const payants = PLANS.filter((p) => p.monthlyPriceCents > 0);

  return (
    <LegalPage
      title="Conditions générales d'utilisation et de vente"
      intro={
        <>
          <p>
            Ces conditions régissent l&apos;accès au service {PRODUCT_NAME} et son utilisation. En
            créant un compte, vous les acceptez. Si vous n&apos;en acceptez pas une clause, vous ne
            pouvez pas utiliser le service.
          </p>
          {/*
            Un contrat de vente doit dire QUI vend. Le texte parlait de
            « l'éditeur » sans jamais le nommer : le cocontractant restait
            anonyme dans le document même qui l'engage.
          */}
          <p className="mt-3">
            Le service est édité et commercialisé par{" "}
            <LegalValue value={PUBLISHER.legalName} />
            {PUBLISHER.tradeName ? ` (${PUBLISHER.tradeName})` : ""}
            {PUBLISHER.registration ? `, ${PUBLISHER.registration}` : ""}, ci-après
            «&nbsp;l&apos;éditeur&nbsp;». Son identité complète figure dans les{" "}
            <a href="/legal" className="text-primary underline-offset-4 hover:underline">
              mentions légales
            </a>
            .
          </p>
        </>
      }
    >
      <LegalSection id="objet" title="1. Objet du service">
        <p>
          {PRODUCT_NAME} permet d&apos;importer un contenu une seule fois, de le préparer, puis de le
          publier sur plusieurs réseaux sociaux au moyen des interfaces de programmation officielles
          de ces réseaux.
        </p>
        <p>
          {PRODUCT_NAME} est un intermédiaire technique. Il ne modère, n&apos;approuve ni ne relaie
          éditorialement vos contenus : il exécute les publications que vous demandez, vers les
          comptes que vous avez vous-même connectés.
        </p>
      </LegalSection>

      <LegalSection id="compte" title="2. Compte et éligibilité">
        <p>
          La création d&apos;un compte suppose d&apos;être une personne physique majeure disposant de
          la capacité de contracter, ou d&apos;agir pour le compte d&apos;une personne morale que
          vous avez le pouvoir d&apos;engager.
        </p>
        <p>
          Vous êtes responsable de la confidentialité de vos identifiants et des actions effectuées
          depuis votre compte. Prévenez-nous sans délai à{" "}
          <a
            href={`mailto:${PUBLISHER.contactEmail}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {PUBLISHER.contactEmail}
          </a>{" "}
          si vous suspectez un accès non autorisé.
        </p>
      </LegalSection>

      <LegalSection id="reseaux" title="3. Connexion de vos comptes sociaux">
        <p>
          Connecter un compte social suppose que vous en soyez titulaire ou que vous disposiez de
          l&apos;autorisation de son titulaire. Vous restez tenu au respect des conditions propres à
          chaque réseau : les nôtres ne s&apos;y substituent pas et ne peuvent pas vous en délier.
        </p>
        <p>
          L&apos;autorisation que vous accordez est révocable à tout moment, depuis {PRODUCT_NAME} ou
          depuis le réseau concerné. Une révocation interrompt la publication vers ce compte.
        </p>
        {/*
          Exigence des YouTube API Services Terms of Service : un client d'API
          doit afficher un lien vers les conditions de YouTube et indiquer que
          l'utilisateur y est lié. Ce lien est OBLIGATOIRE et son absence est un
          motif de refus courant lors de l'audit de conformité.
        */}
        <p>
          {PRODUCT_NAME} publie sur YouTube au moyen des{" "}
          <span className="font-medium">YouTube API Services</span>. En utilisant les fonctions
          YouTube de {PRODUCT_NAME}, vous acceptez d&apos;être lié par les{" "}
          <a
            href="https://www.youtube.com/t/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            Conditions d&apos;utilisation de YouTube
          </a>
          . Elles s&apos;appliquent en plus des présentes conditions, et les nôtres ne peuvent pas
          vous en délier.
        </p>
      </LegalSection>

      <LegalSection id="contenus" title="4. Vos contenus et vos responsabilités">
        <p>
          Vous conservez tous vos droits sur les contenus que vous importez. Vous nous accordez la
          seule autorisation technique nécessaire à leur hébergement et à leur transmission vers les
          réseaux que vous désignez, pour la durée strictement nécessaire à cette exécution.
        </p>
        <p>Vous vous engagez à ne pas utiliser le service pour diffuser des contenus :</p>
        <ul className="list-disc pl-5">
          <li>portant atteinte aux droits d&apos;autrui, notamment de propriété intellectuelle ;</li>
          <li>illicites, haineux, diffamatoires, ou constitutifs de harcèlement ;</li>
          <li>à caractère pédopornographique ou faisant l&apos;apologie du terrorisme ;</li>
          <li>trompeurs quant à leur origine ou à leur auteur.</li>
        </ul>
        <p>
          Vous vous engagez également à ne pas contourner les quotas techniques, à ne pas tenter
          d&apos;accéder aux données d&apos;un autre utilisateur, et à ne pas automatiser
          d&apos;usage abusif des API des réseaux par l&apos;intermédiaire du service.
        </p>
      </LegalSection>

      <LegalSection id="offres" title="5. Offres et prix">
        {gratuit ? (
          <p>
            L&apos;offre {gratuit.name} est gratuite et limitée à {gratuit.quotas.members}{" "}
            membre par espace de travail, {gratuit.quotas.socialAccounts} comptes sociaux,{" "}
            {gratuit.quotas.publicationsPerMonth} publications par mois et{" "}
            {gratuit.quotas.storageGb} Go de stockage.
          </p>
        ) : null}
        <p>
          Les offres payantes, en euros
          {VAT_NOTICE ? <> — {VAT_NOTICE.toLowerCase()}</> : ", toutes taxes comprises"} :
        </p>
        <ul className="list-disc pl-5">
          {payants.map((plan) => (
            <li key={plan.key}>
              <span className="font-medium">{plan.name}</span> —{" "}
              {formatPlanPrice(plan.monthlyPriceCents)} par mois ou{" "}
              {formatPlanPrice(plan.yearlyPriceCents)} par an ; {plan.quotas.members} membres par
              espace de travail, {plan.quotas.socialAccounts} comptes sociaux,{" "}
              {plan.quotas.publicationsPerMonth} publications par mois,{" "}
              {plan.quotas.storageGb} Go de stockage.
            </li>
          ))}
        </ul>
        <p>
          Les prix en vigueur sont ceux affichés au moment de la souscription. Une évolution
          tarifaire ne s&apos;applique jamais à une période déjà payée ; elle vous est annoncée avant
          le renouvellement, que vous restez libre d&apos;interrompre.
        </p>
      </LegalSection>

      <LegalSection id="paiement" title="6. Paiement, durée et résiliation">
        <p>
          Les paiements sont traités par Stripe. {PRODUCT_NAME} ne collecte, ne voit ni ne conserve
          vos données de carte bancaire.
        </p>
        <p>
          L&apos;abonnement est conclu pour la période choisie et se renouvelle par tacite
          reconduction, sauf résiliation avant l&apos;échéance. La résiliation s&apos;effectue depuis
          l&apos;espace de facturation ; elle prend effet au terme de la période en cours, sans
          remboursement au prorata de cette période, et vous conservez l&apos;accès jusque-là.
        </p>
      </LegalSection>

      <LegalSection id="retractation" title="7. Droit de rétractation">
        <p>
          Si vous souscrivez en qualité de consommateur, vous disposez d&apos;un délai de quatorze
          jours à compter de la souscription pour vous rétracter, sans motif ni pénalité.
        </p>
        <p>
          Le service étant fourni immédiatement, ce délai ne s&apos;éteint avant son terme que si
          vous avez expressément demandé cette exécution immédiate ET expressément renoncé à votre
          droit de rétractation. Dans ce cas, vous restez redevable du montant correspondant au
          service effectivement fourni jusqu&apos;à votre demande de rétractation.
        </p>
        <p>
          Pour exercer ce droit, il suffit d&apos;écrire à{" "}
          <a
            href={`mailto:${PUBLISHER.contactEmail}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {PUBLISHER.contactEmail}
          </a>{" "}
          avant l&apos;expiration du délai.
        </p>
      </LegalSection>

      <LegalSection id="disponibilite" title="8. Disponibilité et dépendance à des tiers">
        <p>
          {PRODUCT_NAME} publie au moyen des API d&apos;Instagram, Facebook, YouTube et TikTok. Ces
          API appartiennent à des tiers qui peuvent, sans préavis, les modifier, en restreindre
          l&apos;accès, appliquer leurs propres quotas, refuser une publication ou suspendre un
          compte.
        </p>
        <p>
          En conséquence, {PRODUCT_NAME} s&apos;engage à mettre en œuvre les moyens nécessaires au
          bon fonctionnement du service, mais <span className="font-medium">ne garantit pas</span>{" "}
          qu&apos;une publication donnée aboutira sur un réseau donné, ni que ce réseau la
          conservera. Nous vous signalons les échecs que nous constatons ; nous ne pouvons pas nous
          substituer à la décision d&apos;une plateforme.
        </p>
        <p>
          Le service peut être interrompu pour maintenance. Nous cherchons à en réduire la durée et à
          prévenir lorsque l&apos;interruption est programmée.
        </p>
      </LegalSection>

      <LegalSection id="responsabilite" title="9. Responsabilité">
        <p>
          {PRODUCT_NAME} répond des dommages directs qui lui sont imputables. Sa responsabilité ne
          saurait être engagée à raison des contenus que vous publiez, des décisions des réseaux
          sociaux, d&apos;une perte d&apos;audience ou de revenus, ni d&apos;un usage du service
          contraire aux présentes.
        </p>
        <p>
          Aucune stipulation des présentes ne limite la responsabilité de l&apos;éditeur en cas de
          faute lourde ou dolosive, ni ne prive un consommateur des droits que la loi lui reconnaît.
        </p>
      </LegalSection>

      <LegalSection id="suspension" title="10. Suspension et résiliation par l'éditeur">
        <p>
          En cas de manquement grave aux présentes, notamment la diffusion de contenus illicites ou
          une atteinte à la sécurité du service, l&apos;accès peut être suspendu. Sauf urgence ou
          obligation légale, la suspension est précédée d&apos;une information et, lorsque cela est
          possible, d&apos;une mise en demeure restée sans effet.
        </p>
      </LegalSection>

      <LegalSection id="donnees" title="11. Données personnelles">
        <p>
          Le traitement de vos données personnelles est décrit dans la{" "}
          <a href="/privacy" className="text-primary underline-offset-4 hover:underline">
            politique de confidentialité
          </a>
          , qui fait partie intégrante des présentes.
        </p>
      </LegalSection>

      <LegalSection id="evolution" title="12. Évolution des conditions">
        <p>
          Ces conditions peuvent évoluer avec le service. Toute modification substantielle vous est
          annoncée avant son entrée en vigueur. Continuer à utiliser le service après cette date vaut
          acceptation ; à défaut, vous pouvez résilier sans frais.
        </p>
      </LegalSection>

      <LegalSection id="droit" title="13. Droit applicable et différends">
        <p>
          Les présentes sont régies par le droit français. En cas de différend, une solution amiable
          sera recherchée en priorité en écrivant à{" "}
          <a
            href={`mailto:${PUBLISHER.contactEmail}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {PUBLISHER.contactEmail}
          </a>
          .
        </p>
        <p>
          Un consommateur peut recourir gratuitement à un médiateur de la consommation, ou saisir la
          plateforme européenne de règlement en ligne des litiges. À défaut d&apos;accord, les
          tribunaux compétents sont ceux désignés par les règles de droit commun.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
