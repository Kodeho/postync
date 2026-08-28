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
  legalName: "Kodeho",
  legalForm: "Micro-entreprise",
  // Une micro-entreprise n'a pas de capital social : le champ reste nul et la
  // ligne n'est pas affichée, plutôt que d'annoncer « 0 € ».
  shareCapital: null,
  address: "35 rue de Les Coves, 66000 Perpignan, France",
  registration: "535 194 799 R.C.S. Perpignan",
  // Nul tant que l'assujettissement n'est pas confirmé. Une micro-entreprise
  // sous les seuils relève de la franchise en base (art. 293 B du CGI) et ne
  // facture pas de TVA : afficher un numéro inexact serait une faute.
  vatNumber: null,
  publicationDirector: "Ludovic Piraino",
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
