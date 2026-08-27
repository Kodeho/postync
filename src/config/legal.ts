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

/** Date de dernière mise à jour affichée sur les documents. */
export const LEGAL_LAST_UPDATED = "2026-08-27";

export type Publisher = {
  /** Dénomination commerciale du service. */
  brand: string;
  /** Raison sociale de l'éditeur. */
  legalName: string | null;
  /** Forme juridique (SASU, SARL, entrepreneur individuel…). */
  legalForm: string | null;
  /** Capital social, si société. */
  shareCapital: string | null;
  /** Adresse postale du siège. */
  address: string | null;
  /** Numéro d'immatriculation (SIREN, RCS…). */
  registration: string | null;
  /** Numéro de TVA intracommunautaire, si assujetti. */
  vatNumber: string | null;
  /** Directeur de la publication (art. 6 III LCEN). */
  publicationDirector: string | null;
  /** Adresse de contact, également utilisée pour les demandes RGPD. */
  contactEmail: string;
};

export const PUBLISHER: Publisher = {
  brand: "POSTYNC",
  legalName: null,
  legalForm: null,
  shareCapital: null,
  address: null,
  registration: null,
  vatNumber: null,
  publicationDirector: null,
  contactEmail: "contact@kodeho.com",
};

/**
 * Sous-traitants au sens de l'article 28 du RGPD : ils traitent des données
 * personnelles POUR le compte de POSTYNC, sur ses instructions.
 *
 * Les plateformes sociales n'y figurent PAS : elles ne traitent rien pour nous.
 * C'est l'utilisateur qui les autorise, et elles sont responsables de leur
 * propre traitement — la distinction change les obligations, elle n'est pas
 * cosmétique.
 */
/**
 * Région d'exécution des fonctions Vercel.
 *
 * ATTENTION — ces trois constantes décrivent la réalité MESURÉE, pas un
 * souhait : sans `regions` dans la configuration, Vercel exécute en `iad1`
 * (Washington). La base vivant à Londres, chaque requête traverse
 * l'Atlantique et des données personnelles sont traitées aux États-Unis.
 * Si la région change, ces trois valeurs changent AVEC elle.
 */
export const HOSTING_REGION_LABEL = "Washington, États-Unis (région iad1)";
export const HOSTING_OUTSIDE_EEA = true;
export const HOSTING_SAFEGUARD =
  "Clauses contractuelles types de la Commission européenne, prévues par l'accord de traitement des données de Vercel";

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
    ["legalName", "Raison sociale de l'éditeur"],
    ["legalForm", "Forme juridique"],
    ["address", "Adresse du siège"],
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
