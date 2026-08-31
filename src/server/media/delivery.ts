import "server-only";

/**
 * Livraison des médias aux plateformes — isolation de l'HÔTE.
 *
 * Une plateforme qui publie « par URL » (Instagram, Facebook, TikTok
 * PULL_FROM_URL) va chercher le fichier elle-même. L'URL qu'on lui remet est
 * donc un point d'exposition, et son HÔTE est une décision d'infrastructure :
 *
 *   - aujourd'hui, les URL signées sortent de Supabase Storage et portent
 *     l'hôte du projet (`<ref>.supabase.co`) ;
 *   - demain, le domaine personnalisé Supabase (`api.postync.app`) servira
 *     exactement les mêmes objets, sous un hôte que nous possédons — et que
 *     TikTok peut donc vérifier, ce qu'il exige pour PULL_FROM_URL.
 *
 * Ce module existe pour que cette bascule soit UNE VARIABLE D'ENVIRONNEMENT,
 * et non une reprise de la logique de publication. Aucun provider ne connaît
 * l'hôte de stockage : il reçoit une URL déjà résolue, et se contente de
 * vérifier qu'elle satisfait SES contraintes.
 *
 * Pourquoi la réécriture d'origine est sûre : Supabase signe le CHEMIN de
 * l'objet, pas l'autorité. Le jeton reste valide sous le domaine
 * personnalisé, qui sert le même projet. On ne réécrit d'ailleurs que ce qui
 * vient RÉELLEMENT du projet Supabase — voir `toDeliveryUrl`.
 */

/**
 * Origine publique des médias, quand elle diffère de celle du projet
 * Supabase. Vide tant que le domaine personnalisé n'est pas actif : la valeur
 * par défaut ne doit RIEN inventer, sans quoi on forgerait des URL vers un
 * hôte qui ne répond pas encore.
 */
export function mediaDeliveryOrigin(): string | null {
  const brut = (process.env.MEDIA_DELIVERY_ORIGIN ?? "").trim();
  if (brut.length === 0) return null;
  try {
    const url = new URL(brut);
    // Un média servi en clair serait refusé par les trois plateformes.
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Origine du projet Supabase — origine SOURCE des URL signées. */
export function storageOrigin(): string | null {
  const brut = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (brut.length === 0) return null;
  try {
    return new URL(brut).origin;
  } catch {
    return null;
  }
}

/**
 * URL réellement remise à la plateforme.
 *
 * Sans domaine personnalisé configuré, l'URL signée ressort telle quelle :
 * le comportement d'aujourd'hui, inchangé. Avec, seule l'autorité change —
 * chemin, requête et jeton de signature sont préservés à l'octet près.
 *
 * La réécriture est CONDITIONNÉE à l'origine d'entrée : une URL saisie à la
 * main par l'utilisateur (chemin historique de `publish.ts`) n'a aucune
 * raison d'être détournée vers notre domaine, et ne l'est pas.
 */
export function toDeliveryUrl(signedUrl: string): string {
  const cible = mediaDeliveryOrigin();
  if (cible === null) return signedUrl;

  const source = storageOrigin();
  if (source === null) return signedUrl;

  let url: URL;
  try {
    url = new URL(signedUrl);
  } catch {
    return signedUrl;
  }
  if (url.origin !== source) return signedUrl;

  return `${cible}${url.pathname}${url.search}`;
}

/**
 * `hote` appartient-il à `domaine`, ou à l'un de ses sous-domaines ?
 *
 * La comparaison suit la règle de vérification de TikTok : un domaine vérifié
 * couvre ses sous-domaines. Le point de séparation est obligatoire —
 * `evilpostync.app` ne doit JAMAIS passer pour un sous-domaine de
 * `postync.app`, et une comparaison par suffixe nu laisserait exactement
 * cette porte ouverte.
 */
export function isHostWithinDomain(hote: string, domaine: string): boolean {
  const h = hote.trim().toLowerCase().replace(/\.$/, "");
  const d = domaine.trim().toLowerCase().replace(/\.$/, "");
  if (h.length === 0 || d.length === 0) return false;
  return h === d || h.endsWith(`.${d}`);
}

/** Motif de refus d'une URL destinée à un transfert « la plateforme tire ». */
export type DeliveryRejection =
  | "malformed"
  | "not_https"
  | "embedded_credentials"
  | "host_not_verified";

/**
 * L'URL est-elle transmissible à une plateforme qui exige un domaine dont
 * nous avons prouvé la propriété (TikTok PULL_FROM_URL) ?
 *
 * Renvoie `null` si tout va bien, sinon le motif exact. Aucune requête n'est
 * faite : on ne peut pas vérifier ici l'absence de redirection 3xx, qui
 * dépend de l'hôte — c'est justement pourquoi l'hôte doit être le nôtre.
 */
export function checkVerifiedDelivery(
  mediaUrl: string,
  verifiedDomain: string,
): DeliveryRejection | null {
  let url: URL;
  try {
    url = new URL(mediaUrl);
  } catch {
    return "malformed";
  }
  if (url.protocol !== "https:") return "not_https";
  if (url.username || url.password) return "embedded_credentials";
  if (!isHostWithinDomain(url.hostname, verifiedDomain)) return "host_not_verified";
  return null;
}
