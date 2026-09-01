/**
 * Informations légales du service — source unique de vérité.
 *
 * Les pages `/legal`, `/terms` et `/privacy` lisent TOUTES d'ici : une
 * information légale contradictoire d'une page à l'autre est une faute en soi.
 *
 * Les champs à `null` sont ceux que seul l'éditeur peut fournir (identité
 * juridique, adresse, immatriculation). Ils ne sont pas inventés : une mention
 * légale fausse est pire qu'une mention absente, et `missingLegalFields()`
 * permet de savoir exactement ce qui manque encore. Les pages affichent un
 * marqueur visible tant qu'un champ obligatoire est vide — impossible de
 * publier sans s'en apercevoir.
 */

/**
 * VERSIONS DES DOCUMENTS — source unique.
 *
 * Ce sont les valeurs enregistrées dans `legal_acceptances` : ce que
 * l'utilisateur a accepté, et à quelle date de document. Les deux sont
 * séparées parce qu'elles évoluent séparément — corriger une clause des CGU
 * ne doit pas invalider l'acceptation de la politique, et inversement.
 *
 * CHANGER L'UNE DE CES VALEURS REDEMANDE L'ACCEPTATION À TOUT LE MONDE. C'est
 * délibéré : une acceptation ne vaut que pour la version acceptée. La garde
 * compare le couple enregistré au couple courant ; il n'y a pas d'autre
 * mécanisme à activer, et rien à migrer.
 *
 * Format `AAAA-MM-JJ`, la date d'entrée en vigueur du document — lisible dans
 * une base comme dans un échange avec un utilisateur, contrairement à un
 * numéro de révision.
 */
export const TERMS_VERSION = "2026-08-28";
export const PRIVACY_VERSION = "2026-08-28";

/**
 * Date de dernière mise à jour affichée sur les documents. Dérivée des deux
 * versions ci-dessus : elle ne peut pas dériver de ce qui est réellement
 * accepté.
 */
export const LEGAL_LAST_UPDATED =
  TERMS_VERSION >= PRIVACY_VERSION ? TERMS_VERSION : PRIVACY_VERSION;

/**
 * Mention obligatoire accompagnant les prix quand l'éditeur relève de la
 * franchise en base de TVA : il ne la facture pas, et doit le dire.
 *
 * Vaut `null` s'il devient assujetti — les prix s'afficheront alors avec la
 * mention TTC habituelle, et `PUBLISHER.vatNumber` devra être renseigné.
 */
export const VAT_NOTICE: string | null = "TVA non applicable, article 293 B du CGI";

export type Publisher = {
  /** Dénomination commerciale du SERVICE (le produit). */
  brand: string;
  /**
   * Identité juridique de l'éditeur, telle qu'elle figure au registre.
   *
   * ATTENTION — ce champ n'est PAS le nom commercial. Pour un entrepreneur
   * individuel, le registre ne connaît que la personne physique : c'est son
   * nom d'état civil complet qui doit figurer ici, et c'est lui qui doit
   * correspondre au justificatif officiel (Kbis, avis SIRENE) partout où un
   * tiers — plateforme, banque, administration — demande « la dénomination
   * légale ». Y écrire la marque était une inexactitude au regard de
   * l'article 6 III de la LCEN, corrigée le 2026-08-30 sur pièce.
   */
  legalName: string | null;
  /**
   * Nom commercial sous lequel l'éditeur exerce, s'il diffère du nom légal.
   *
   * Il reste la marque VISIBLE — on ne le remplace pas par le nom d'état civil
   * dans l'interface. Les deux coexistent : le nom légal identifie, le nom
   * commercial désigne.
   */
  tradeName: string | null;
  /** Forme juridique (SASU, SARL, entrepreneur individuel…). */
  legalForm: string | null;
  /** Capital social, si société. */
  shareCapital: string | null;
  /** Adresse postale de l'établissement. */
  address: string | null;
  /** Numéro d'immatriculation (SIREN, RCS…). */
  registration: string | null;
  /** Numéro de TVA intracommunautaire, si assujetti. */
  vatNumber: string | null;
  /** Directeur de la publication (art. 6 III LCEN). */
  publicationDirector: string | null;
  /**
   * Site institutionnel de l'ENTREPRISE — distinct du site du produit.
   *
   * `postync.app` est l'adresse de POSTYNC ; celle-ci est celle de l'éditeur,
   * et c'est la seule qui figure au registre. Les confondre lors d'une
   * vérification d'entreprise crée un écart avec le justificatif.
   */
  website: string | null;
  /** Adresse de contact, également utilisée pour les demandes RGPD. */
  contactEmail: string;
};

export const PUBLISHER: Publisher = {
  brand: "POSTYNC",
  // Identité d'état civil portée au Kbis — vérifiée sur pièce le 2026-08-30.
  legalName: "PIRAINO Ludovic Fernand Louis",
  tradeName: "Kodeho",
  legalForm: "Entrepreneur individuel (micro-entreprise)",
  // Un entrepreneur individuel n'a pas de capital social : le champ reste nul
  // et la ligne n'est pas affichée, plutôt que d'annoncer « 0 € ».
  shareCapital: null,
  // Graphie du Kbis, reprise telle quelle : un justificatif se recopie, il ne
  // se normalise pas.
  address: "35 Rue De les Coves, 66000 Perpignan, France",
  registration: "535 194 799 R.C.S. Perpignan",
  // L'éditeur n'est PAS assujetti : franchise en base (art. 293 B du CGI).
  // Le champ reste donc nul, et `VAT_NOTICE` porte la mention qui doit
  // accompagner les prix — l'omettre serait un manquement, inventer un numéro
  // en serait un autre.
  vatNumber: null,
  publicationDirector: "Ludovic Piraino",
  website: "https://www.kodeho.com",
  contactEmail: "contact@kodeho.com",
};

/**
 * Région d'exécution des fonctions Vercel.
 *
 * Ces trois constantes décrivent la réalité MESURÉE, pas un souhait, et
 * doivent suivre `vercel.json`. Sans `regions`, Vercel exécute par défaut en
 * `iad1` (Washington) : c'était le cas jusqu'au 2026-08-27, la base vivant à
 * Londres, donc un aller-retour transatlantique par requête et des données
 * personnelles traitées aux États-Unis. Le calcul est désormais co-localisé
 * avec la base. Un test échoue si la fiche du sous-traitant s'en écarte.
 */
export const HOSTING_REGION_LABEL = "Londres, Royaume-Uni (région lhr1)";
export const HOSTING_OUTSIDE_EEA = true;
export const HOSTING_SAFEGUARD =
  "Décision d'adéquation de la Commission européenne du 28 juin 2021 en faveur du Royaume-Uni";

/**
 * Sous-traitants au sens de l'article 28 du RGPD : ils traitent des données
 * personnelles POUR le compte de POSTYNC, sur ses instructions.
 *
 * Les plateformes sociales n'y figurent PAS : elles ne traitent rien pour nous.
 * C'est l'utilisateur qui les autorise, et elles sont responsables de leur
 * propre traitement — la distinction change les obligations, elle n'est pas
 * cosmétique.
 */
export type Subprocessor = {
  name: string;
  role: string;
  location: string;
  /** Vrai si les données sortent de l'Espace économique européen. */
  outsideEea: boolean;
  safeguard: string | null;
};

export const SUBPROCESSORS: Subprocessor[] = [
  {
    name: "Supabase, Inc.",
    role: "Base de données, authentification et stockage des médias",
    location: "Londres, Royaume-Uni (région eu-west-2)",
    outsideEea: true,
    safeguard:
      "Décision d'adéquation de la Commission européenne du 28 juin 2021 en faveur du Royaume-Uni",
  },
  {
    name: "Vercel, Inc.",
    role: "Hébergement et exécution de l'application",
    location: HOSTING_REGION_LABEL,
    outsideEea: HOSTING_OUTSIDE_EEA,
    safeguard: HOSTING_SAFEGUARD,
  },
  {
    name: "Stripe Payments Europe, Ltd.",
    role: "Paiement des abonnements et facturation",
    location: "Dublin, Irlande",
    outsideEea: false,
    safeguard: null,
  },
];

/**
 * Destinataires vers lesquels POSTYNC transmet des contenus SUR INSTRUCTION
 * de l'utilisateur. Chacun est responsable de traitement pour ce qu'il en
 * fait ensuite : POSTYNC ne peut ni le contrôler ni s'y substituer.
 */
export const SOCIAL_RECIPIENTS = [
  { name: "Meta Platforms Ireland Limited", networks: "Instagram, Facebook" },
  { name: "Google Ireland Limited", networks: "YouTube" },
  { name: "TikTok Technology Limited", networks: "TikTok" },
] as const;

/** Champs obligatoires encore vides. Vide = documents publiables. */
export function missingLegalFields(publisher: Publisher = PUBLISHER): string[] {
  const obligatoires: Array<[keyof Publisher, string]> = [
    ["legalName", "Identité juridique de l'éditeur"],
    ["legalForm", "Forme juridique"],
    ["address", "Adresse de l'établissement"],
    ["registration", "Numéro d'immatriculation (SIREN / RCS)"],
    ["publicationDirector", "Directeur de la publication"],
  ];
  return obligatoires
    .filter(([champ]) => {
      const valeur = publisher[champ];
      return typeof valeur !== "string" || valeur.trim().length === 0;
    })
    .map(([, libelle]) => libelle);
}
