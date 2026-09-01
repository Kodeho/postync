import type { Metadata } from "next";

import { LegalPage, LegalSection, LegalValue } from "@/components/layout/legal-page";
import { PRODUCT_NAME } from "@/config/product";
import { PUBLISHER, SOCIAL_RECIPIENTS, SUBPROCESSORS } from "@/config/legal";

/**
 * Politique de confidentialité.
 *
 * C'est le document que Meta, Google et TikTok examinent lors de leurs audits,
 * et celui qui doit décrire la réalité TECHNIQUE du produit — pas une
 * généralité. D'où trois partis pris :
 *
 * 1. l'inventaire des données est celui des tables réellement présentes ;
 * 2. ce que POSTYNC ne conserve PAS est dit aussi explicitement que ce qu'il
 *    conserve — un jeton social n'est jamais lisible en base, une carte
 *    bancaire n'atteint jamais nos serveurs ;
 * 3. la section « suppression » porte un ancre stable (#suppression) parce que
 *    les plateformes exigent une URL d'instructions de suppression qui pointe
 *    directement dessus.
 */

export const metadata: Metadata = {
  title: `Politique de confidentialité — ${PRODUCT_NAME}`,
  description: `Données personnelles traitées par ${PRODUCT_NAME}, finalités, destinataires, durées et droits.`,
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Politique de confidentialité"
      intro={
        <p>
          Ce document décrit les données personnelles que {PRODUCT_NAME} traite, pourquoi, pendant
          combien de temps, et les droits dont vous disposez. Il décrit le fonctionnement réel du
          service, y compris ce que nous avons choisi de <span className="font-medium">ne pas</span>{" "}
          conserver.
        </p>
      }
    >
      <LegalSection id="responsable" title="1. Responsable du traitement">
        <p>
          {/*
            Le responsable du traitement est une PERSONNE identifiée, pas une
            marque : le RGPD veut savoir qui répond. Le nom commercial suit
            entre parenthèses, parce que c'est sous celui-là que la personne
            concernée nous connaît.
          */}
          Le responsable du traitement est <LegalValue value={PUBLISHER.legalName} />
          {PUBLISHER.tradeName ? ` (${PUBLISHER.tradeName})` : ""}, éditeur de{" "}
          {PUBLISHER.brand}, joignable à{" "}
          <a
            href={`mailto:${PUBLISHER.contactEmail}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {PUBLISHER.contactEmail}
          </a>
          . Son identité complète figure dans les{" "}
          <a href="/legal" className="text-primary underline-offset-4 hover:underline">
            mentions légales
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection id="donnees" title="2. Données traitées">
        <p>Nous traitons les catégories suivantes, et aucune autre :</p>
        <ul className="list-disc pl-5">
          <li>
            <span className="font-medium">Compte</span> — adresse e-mail, mot de passe (jamais stocké
            en clair : seule une empreinte cryptographique est conservée par notre prestataire
            d&apos;authentification), nom affiché, avatar éventuel, date de création.
          </li>
          <li>
            <span className="font-medium">Espaces de travail</span> — nom, adresse lisible, membres et
            leur rôle.
          </li>
          <li>
            <span className="font-medium">Comptes sociaux connectés</span> — réseau, identifiant du
            compte sur ce réseau, nom affiché, avatar, autorisations accordées, date d&apos;expiration
            des jetons.
          </li>
          <li>
            <span className="font-medium">Médias importés</span> — le fichier lui-même, son nom, son
            format, sa taille, sa durée et ses dimensions.
          </li>
          <li>
            <span className="font-medium">Publications</span> — réseau visé, légende, statut,
            identifiant de la publication distante, date.
          </li>
          <li>
            <span className="font-medium">Abonnement</span> — offre souscrite, statut, échéances, et
            l&apos;identifiant client attribué par notre prestataire de paiement.
          </li>
          <li>
            <span className="font-medium">Journaux techniques et d&apos;administration</span> —
            traces nécessaires à la sécurité et au diagnostic.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="non-conserve" title="3. Ce que nous ne conservons pas">
        <ul className="list-disc pl-5">
          <li>
            <span className="font-medium">Aucune donnée de carte bancaire.</span> Le paiement se
            déroule intégralement chez Stripe ; ces informations ne transitent jamais par nos
            serveurs.
          </li>
          <li>
            <span className="font-medium">Aucun jeton social lisible en base.</span> Les jetons
            d&apos;accès délivrés par les réseaux sont conservés chiffrés dans un coffre distinct,
            accessibles au seul serveur. Ils ne sont jamais transmis à votre navigateur, jamais
            affichés, jamais journalisés.
          </li>
          <li>
            <span className="font-medium">Aucune URL d&apos;accès durable à vos médias.</span> Le
            stockage est privé. Une adresse temporaire n&apos;est fabriquée qu&apos;au moment de
            publier, pour que le réseau destinataire puisse récupérer le fichier, et n&apos;est
            jamais enregistrée.
          </li>
          <li>
            <span className="font-medium">Aucun traceur publicitaire ni mesure d&apos;audience.</span>
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="finalites" title="4. Finalités et bases légales">
        <ul className="list-disc pl-5">
          <li>
            <span className="font-medium">Fournir le service</span> (compte, connexion des réseaux,
            stockage, publication) — exécution du contrat.
          </li>
          <li>
            <span className="font-medium">Gérer les abonnements et la facturation</span> — exécution
            du contrat et obligations comptables.
          </li>
          <li>
            <span className="font-medium">Assurer la sécurité</span> (détection d&apos;abus, journaux
            d&apos;administration, application des quotas) — intérêt légitime à protéger le service
            et ses utilisateurs.
          </li>
          <li>
            <span className="font-medium">Répondre à vos demandes</span> — intérêt légitime.
          </li>
        </ul>
        <p>
          La connexion d&apos;un compte social repose sur l&apos;autorisation que vous accordez au
          réseau concerné, révocable à tout moment.
        </p>
      </LegalSection>

      <LegalSection id="reseaux" title="5. Données reçues des réseaux sociaux">
        <p>
          Lorsque vous connectez un compte, nous ne demandons que les autorisations strictement
          nécessaires. Nous récupérons l&apos;identifiant du compte, son nom affiché et son avatar,
          afin que vous puissiez reconnaître le compte sur lequel vous publiez.
        </p>
        <p>
          Nous ne lisons ni vos messages privés, ni vos contacts, ni vos statistiques au-delà de ce
          que vous demandez explicitement. Nous n&apos;utilisons ces données ni à des fins
          publicitaires, ni pour entraîner un modèle, et ne les revendons pas.
        </p>

        {/*
          Divulgation exigee par les YouTube API Services Terms of Service et par
          les Developer Policies : nommer les YouTube API Services, renvoyer a la
          politique de confidentialite de Google ET au panneau de securite Google
          permettant de revoquer l'acces. Les trois liens sont OBLIGATOIRES.

          Tout ce qui suit decrit le comportement REEL du code, pas une intention :
          les donnees listees sont celles que `youtube.ts` lit et que
          `social_accounts` stocke, et les delais sont ceux qu'executent
          `disconnectSocialAccount` et le trigger `social_accounts_purge_secrets`.
        */}
        <h3 className="mt-6 text-base font-semibold text-foreground">YouTube</h3>
        <p>
          {PRODUCT_NAME} utilise les{" "}
          <span className="font-medium">YouTube API Services</span> pour publier vos vidéos sur
          votre chaîne. À ce titre, les données que Google traite le sont conformément à la{" "}
          <a
            href="https://policies.google.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            politique de confidentialité de Google
          </a>
          .
        </p>
        <p className="font-medium">Ce que nous consultons et conservons</p>
        <ul className="list-disc pl-5">
          <li>
            <span className="font-medium">L&apos;identité de votre chaîne</span> — identifiant, nom
            affiché et image de profil, lus une seule fois juste après votre autorisation, pour que
            vous sachiez sur quelle chaîne vous publiez.
          </li>
          <li>
            <span className="font-medium">Les jetons d&apos;autorisation</span> — conservés
            chiffrés dans un coffre, jamais en clair, et jamais accessibles depuis le navigateur.
          </li>
          <li>
            <span className="font-medium">Ce que vous publiez</span> — le titre, la description et
            le fichier que vous nous confiez, puis l&apos;identifiant et le lien de la vidéo créée,
            conservés dans votre historique de publications.
          </li>
        </ul>
        <p>
          Nous ne lisons <span className="font-medium">rien d&apos;autre</span> : ni vos autres
          vidéos, ni vos statistiques, ni vos playlists, ni vos commentaires, ni vos abonnés. La
          seule écriture que nous effectuons est l&apos;envoi de la vidéo que vous avez demandée.
        </p>
        <p className="font-medium">Retirer notre accès</p>
        <ul className="list-disc pl-5">
          <li>
            <span className="font-medium">Depuis {PRODUCT_NAME}</span> — « Déconnecter » sur la page
            Comptes sociaux. Nous demandons{" "}
            <span className="font-medium">immédiatement à Google de révoquer</span> le jeton. Cet
            appel dépend de Google et peut échouer ; c&apos;est pourquoi la suppression chez nous
            n&apos;en dépend pas : la ligne du compte, les jetons du coffre et les données de
            plateforme de votre historique sont supprimés{" "}
            <span className="font-medium">dans tous les cas</span>, en une seule opération. Il ne
            subsiste aucun secret. Si la révocation chez Google n&apos;aboutissait pas, vous pouvez
            toujours retirer l&apos;accès depuis votre compte Google, ci-dessous.
          </li>
          <li>
            <span className="font-medium">Depuis Google</span> — vous pouvez retirer l&apos;accès de{" "}
            {PRODUCT_NAME} à tout moment depuis les{" "}
            <a
              href="https://security.google.com/settings/security/permissions"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              paramètres de sécurité de votre compte Google
            </a>
            .
          </li>
        </ul>
        <p>
          <span className="font-medium">La déconnexion purge aussi votre historique</span> de toute
          donnée venant de YouTube : identifiant de chaîne, identifiant de vidéo, lien de la vidéo
          et identifiant de session d&apos;envoi sont effacés des publications passées, dans la même
          opération que la suppression du compte — jamais l&apos;une sans l&apos;autre.
        </p>
        <p>
          Ne subsiste que ce que vous nous avez donné ou ce qui nous est propre : la date, le
          statut, votre légende et le média que vous aviez importé. Votre historique garde donc son
          sens — « une vidéo est partie sur YouTube tel jour » — sans porter la moindre donnée de la
          plateforme. Une publication encore en cours au moment de la déconnexion est arrêtée : elle
          ne peut pas se poursuivre sans autorisation.
        </p>
        <p>
          La vidéo déjà publiée, elle, <span className="font-medium">reste sur votre chaîne</span> :
          elle vous appartient, et seule YouTube peut la retirer — depuis votre compte YouTube.
        </p>
      </LegalSection>

      <LegalSection id="destinataires" title="6. Destinataires et transferts">
        <p>
          Les prestataires suivants traitent des données pour notre compte, sur nos instructions :
        </p>
        <ul className="list-disc pl-5">
          {SUBPROCESSORS.map((s) => (
            <li key={s.name}>
              <span className="font-medium">{s.name}</span> — {s.role}. Localisation : {s.location}.
              {s.outsideEea && s.safeguard ? (
                <>
                  {" "}
                  Ce traitement implique un transfert hors de l&apos;Espace économique européen,
                  encadré par : {s.safeguard}.
                </>
              ) : null}
            </li>
          ))}
        </ul>
        <p>
          Par ailleurs, vos contenus sont transmis, <span className="font-medium">sur votre
          instruction</span>, aux réseaux que vous avez connectés :
        </p>
        <ul className="list-disc pl-5">
          {SOCIAL_RECIPIENTS.map((r) => (
            <li key={r.name}>
              {r.name} — {r.networks}
            </li>
          ))}
        </ul>
        <p className="text-muted">
          Ces réseaux ne sont pas nos sous-traitants : ils décident eux-mêmes de l&apos;usage
          ultérieur des contenus publiés, selon leurs propres politiques, sur lesquelles nous
          n&apos;avons aucune prise.
        </p>
      </LegalSection>

      <LegalSection id="durees" title="7. Durées de conservation">
        <ul className="list-disc pl-5">
          <li>
            <span className="font-medium">Compte et espaces de travail</span> — tant que le compte
            existe, puis suppression à votre demande.
          </li>
          <li>
            <span className="font-medium">Comptes sociaux connectés et jetons</span> — jusqu&apos;à
            déconnexion. La déconnexion détruit immédiatement les jetons du coffre.
          </li>
          <li>
            <span className="font-medium">Médias</span> — jusqu&apos;à leur suppression par vous.
            Supprimer un média efface réellement le fichier du stockage.
          </li>
          <li>
            <span className="font-medium">Historique des publications</span> — conservé pour le suivi
            des quotas et la traçabilité, puis supprimé avec le compte.
          </li>
          <li>
            <span className="font-medium">Autorisations OAuth en cours</span> — quelques minutes ;
            ces éléments transitoires expirent et sont détruits automatiquement.
          </li>
          <li>
            <span className="font-medium">Pièces comptables</span> — conservées le temps imposé par
            la loi, indépendamment de la suppression du compte.
          </li>
        </ul>
        <p className="text-muted">
          Après suppression, les sauvegardes de nos hébergeurs peuvent contenir une copie résiduelle
          pendant la durée définie par leurs propres politiques de sauvegarde, avant rotation.
        </p>
      </LegalSection>

      <LegalSection id="securite" title="8. Sécurité">
        <ul className="list-disc pl-5">
          <li>Chiffrement des échanges en transit et des données au repos.</li>
          <li>
            Cloisonnement des espaces de travail appliqué par la base de données elle-même : une
            requête ne peut pas atteindre les données d&apos;un espace auquel vous n&apos;appartenez
            pas.
          </li>
          <li>
            Jetons sociaux isolés dans un coffre chiffré, hors de portée des requêtes applicatives
            ordinaires.
          </li>
          <li>Stockage des médias privé par défaut, sans accès public.</li>
          <li>Journalisation des actions d&apos;administration, sans aucun secret.</li>
        </ul>
      </LegalSection>

      <LegalSection id="cookies" title="9. Cookies">
        <p>
          {PRODUCT_NAME} n&apos;utilise que les cookies strictement nécessaires au maintien de votre
          session. Aucun cookie publicitaire, aucune mesure d&apos;audience, aucun traceur tiers.
          C&apos;est la raison pour laquelle aucun bandeau de consentement ne vous est imposé : il
          n&apos;y a rien à consentir.
        </p>
      </LegalSection>

      <LegalSection id="suppression" title="10. Supprimer vos données">
        <p>Vous pouvez agir vous-même, immédiatement :</p>
        <ul className="list-disc pl-5">
          <li>
            <span className="font-medium">Retirer un réseau</span> — « Déconnecter » sur la page
            Comptes sociaux. Les jetons sont détruits et, lorsque le réseau le permet,
            l&apos;autorisation est révoquée chez lui.
          </li>
          <li>
            <span className="font-medium">Supprimer un média</span> — « Supprimer » dans la
            Médiathèque efface le fichier du stockage.
          </li>
          <li>
            <span className="font-medium">Depuis le réseau lui-même</span> — vous pouvez retirer
            l&apos;accès de {PRODUCT_NAME} dans les réglages de votre compte Instagram, Facebook,
            YouTube ou TikTok.
          </li>
        </ul>
        <p>
          Pour la <span className="font-medium">suppression complète de votre compte</span> et de
          l&apos;ensemble des données associées, écrivez à{" "}
          <a
            href={`mailto:${PUBLISHER.contactEmail}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {PUBLISHER.contactEmail}
          </a>{" "}
          depuis l&apos;adresse du compte concerné. La demande est traitée dans un délai maximal de
          trente jours, et confirmée une fois exécutée.
        </p>
      </LegalSection>

      <LegalSection id="droits" title="11. Vos droits">
        <p>
          Vous disposez des droits d&apos;accès, de rectification, d&apos;effacement, de limitation,
          d&apos;opposition et de portabilité, ainsi que du droit de définir des directives relatives
          au sort de vos données après votre décès.
        </p>
        <p>
          Ces droits s&apos;exercent auprès de{" "}
          <a
            href={`mailto:${PUBLISHER.contactEmail}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {PUBLISHER.contactEmail}
          </a>
          . Une pièce justificative d&apos;identité peut être demandée en cas de doute raisonnable
          sur l&apos;identité du demandeur, et uniquement dans ce cas.
        </p>
        <p>
          Si notre réponse ne vous satisfait pas, vous pouvez introduire une réclamation auprès de la
          Commission nationale de l&apos;informatique et des libertés (CNIL),{" "}
          <a
            href="https://www.cnil.fr"
            className="text-primary underline-offset-4 hover:underline"
            rel="noreferrer noopener"
            target="_blank"
          >
            www.cnil.fr
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection id="evolution" title="12. Évolution de cette politique">
        <p>
          Cette politique évolue avec le service. Toute modification substantielle vous est annoncée
          avant son entrée en vigueur. La date de dernière mise à jour figure en tête de ce document.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
