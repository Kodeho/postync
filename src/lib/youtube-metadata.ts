/**
 * Métadonnées d'upload YouTube — vocabulaire et validation.
 *
 * Ce module est VOLONTAIREMENT pur : aucun accès réseau, aucune dépendance
 * serveur, pas de `server-only`. Le formulaire et les actions serveur en
 * partagent donc les mêmes constantes et la même fonction de validation, et
 * ne peuvent pas diverger — c'est exactement ce qui manquait au titre, présent
 * dans le formulaire et absent de la programmation.
 *
 * LE SERVEUR NE FAIT PAS CONFIANCE AU FORMULAIRE. `parseYouTubeMetadata` est
 * appelée par `publish.ts` et `schedule.ts` sur les données brutes du
 * `FormData`, pas sur un objet déjà façonné par le client. Une requête forgée
 * à la main est donc soumise aux mêmes contrôles.
 */

/** `snippet.title` : au-delà, `videos.insert` répond une erreur. */
export const YOUTUBE_TITLE_MAX_LENGTH = 100;

/**
 * Les trois visibilités que la Required Minimum Functionality impose d'offrir :
 * « Users must be able to choose whether the uploaded video will be public,
 * private, or unlisted. »
 *
 * `private` est présélectionné côté formulaire, pas imposé ici : le défaut est
 * une commodité, la contrainte serait une infraction.
 */
export const YOUTUBE_PRIVACY_STATUSES = ["private", "unlisted", "public"] as const;

export type YouTubePrivacyStatus = (typeof YOUTUBE_PRIVACY_STATUSES)[number];

export function isYouTubePrivacyStatus(value: unknown): value is YouTubePrivacyStatus {
  return (
    typeof value === "string" &&
    (YOUTUBE_PRIVACY_STATUSES as readonly string[]).includes(value)
  );
}

/** Ce qu'une publication YouTube doit porter, une fois validée. */
export type YouTubeMetadata = {
  title: string;
  privacyStatus: YouTubePrivacyStatus;
  /** Déclaration de l'utilisateur, jamais un défaut applicatif. */
  madeForKids: boolean;
  /** Horodatage de la certification Community Guidelines. */
  guidelinesAcknowledgedAt: string;
};

/**
 * Codes d'échec courts et stables. Ils partent en base (`status_detail`) et
 * remontent à l'interface, qui en connaît les libellés. Aucun ne transporte de
 * donnée saisie.
 */
export type YouTubeMetadataErrorCode =
  | "youtube_title_required"
  | "youtube_title_too_long"
  | "youtube_privacy_invalid"
  | "youtube_made_for_kids_required"
  | "youtube_guidelines_required";

export type YouTubeMetadataInput = {
  title?: string | null;
  privacyStatus?: string | null;
  /**
   * `null`/`undefined` signifie « la personne n'a pas répondu », et c'est un
   * REFUS — pas un `false` implicite. Déclarer « non destiné aux enfants » à la
   * place de quelqu'un engagerait sa responsabilité au titre de la COPPA.
   */
  madeForKids?: boolean | null;
  guidelinesAcknowledged?: boolean | null;
};

export type YouTubeMetadataResult =
  | { ok: true; value: YouTubeMetadata }
  | { ok: false; code: YouTubeMetadataErrorCode };

/**
 * Valide les métadonnées d'une publication YouTube.
 *
 * @param now Injecté pour que les tests n'aient pas à composer avec l'horloge.
 */
export function parseYouTubeMetadata(
  input: YouTubeMetadataInput,
  now: () => number = Date.now,
): YouTubeMetadataResult {
  const title = (input.title ?? "").trim();
  if (title.length === 0) {
    return { ok: false, code: "youtube_title_required" };
  }
  if (title.length > YOUTUBE_TITLE_MAX_LENGTH) {
    return { ok: false, code: "youtube_title_too_long" };
  }

  if (!isYouTubePrivacyStatus(input.privacyStatus)) {
    return { ok: false, code: "youtube_privacy_invalid" };
  }

  if (typeof input.madeForKids !== "boolean") {
    return { ok: false, code: "youtube_made_for_kids_required" };
  }

  if (input.guidelinesAcknowledged !== true) {
    return { ok: false, code: "youtube_guidelines_required" };
  }

  return {
    ok: true,
    value: {
      title,
      privacyStatus: input.privacyStatus,
      madeForKids: input.madeForKids,
      guidelinesAcknowledgedAt: new Date(now()).toISOString(),
    },
  };
}

/**
 * Relit des métadonnées DÉJÀ enregistrées, pour une publication programmée que
 * le planificateur reprend.
 *
 * La différence avec `parseYouTubeMetadata` est délibérée : la certification a
 * été donnée à la saisie et son horodatage est en base — on ne la redemande
 * pas, on vérifie qu'elle existe. Une ligne programmée avant cette migration
 * n'en porte aucune : elle est refusée ici plutôt qu'envoyée à Google sans les
 * déclarations exigées.
 */
export function readStoredYouTubeMetadata(row: {
  title?: string | null;
  privacy_status?: string | null;
  made_for_kids?: boolean | null;
  guidelines_acknowledged_at?: string | null;
}): YouTubeMetadataResult {
  return parseYouTubeMetadata(
    {
      title: row.title,
      privacyStatus: row.privacy_status,
      madeForKids: row.made_for_kids,
      guidelinesAcknowledged: typeof row.guidelines_acknowledged_at === "string",
    },
    // L'horodatage rendu est celui de la saisie, pas celui de la reprise.
    () => (row.guidelines_acknowledged_at ? Date.parse(row.guidelines_acknowledged_at) : Date.now()),
  );
}
