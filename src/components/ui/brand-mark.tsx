/**
 * Monogramme POSTYNC — le symbole EXISTANT, pas une lettre redessinée.
 *
 * SOURCE UNIQUE DE LA GÉOMÉTRIE. Tout emplacement de marque de l'application
 * passe par ce composant : navigation, connexion, surcouche de transfert,
 * icône d'application. Une seule définition, donc des proportions
 * rigoureusement identiques partout — c'est la contrainte, et c'est aussi la
 * raison d'être du fichier.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LE TRACÉ EST RELEVÉ, PAS DESSINÉ
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Une première version avait construit un « P » géométrique — fût
 * rectangulaire, panse en demi-cercle. C'était une AUTRE marque : elle perdait
 * les trois traits caractéristiques qui partent vers la gauche, qui sont
 * précisément ce qui distingue le symbole de POSTYNC d'une initiale
 * quelconque. Elle a été abandonnée.
 *
 * Le `d` ci-dessous est le contour RELEVÉ sur le logo d'origine. La frontière
 * a été extraite en iso-contour à mi-parcours de l'anticrénelage (marching
 * squares avec interpolation linéaire), puis simplifiée par Douglas-Peucker
 * sous le demi-pixel. Conséquence : les formes, les proportions et les
 * espacements sont ceux du fichier source, au sous-pixel près — y compris
 * l'inclinaison des trois traits et la largeur des intervalles entre eux.
 *
 * Seul le TRAITEMENT GRAPHIQUE change : le dégradé bleu-violet devient un
 * aplat noir. Le dessin, lui, n'a pas bougé d'un pixel.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUE LE SYMBOLE NE FAIT PAS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Aucun dégradé, aucune couleur, aucune ombre, aucun effet de relief. Le fond
 * est blanc PLEIN et le contour extérieur noir et fin — y compris sur fond
 * sombre, où la vignette se détache alors en blanc. C'est voulu : un seul
 * symbole, identique partout, plutôt qu'une variante par contexte qu'il
 * faudrait maintenir et qui finirait par diverger.
 *
 * Le trait du contour est exprimé dans le repère du `viewBox` (1.5 sur 32),
 * donc PROPORTIONNEL : il reste visuellement aussi fin à 20 px qu'à 96 px.
 * Un `vector-effect="non-scaling-stroke"` aurait produit l'inverse — un trait
 * épais en petit, filiforme en grand.
 */

/**
 * Contour du symbole, dans le repère `0 0 32 32`.
 *
 * Un seul sous-tracé : le contour fait le tour de la panse PUIS revient
 * évider le contre-poinçon par un pont — c'est la topologie du logo d'origine,
 * et c'est pourquoi le remplissage doit être `evenodd`. En `nonzero`, le
 * contre-poinçon se remplirait et le « P » deviendrait un bloc.
 */
const CONTOUR =
  "M10.67 7.27L10.43 7.47L10.42 11.73L10.49 12.00L10.67 12.12L12.53 12.06L13.07 11.85L14.13 11.08L14.67 10.82L15.47 10.62L19.20 10.57L19.73 10.63L20.27 10.81L20.80 11.15L21.13 11.47L21.69 12.53L21.72 14.13L21.41 14.93L20.53 15.81L19.73 16.11L19.47 16.12L16.27 16.12L15.73 16.03L15.20 15.83L14.71 15.47L12.80 13.79L12.27 13.50L11.47 13.20L10.13 13.04L7.20 13.02L6.93 13.16L6.83 13.33L6.84 15.20L6.93 15.48L7.20 15.58L10.40 15.58L11.47 15.67L12.53 16.15L13.60 16.92L13.87 16.97L14.13 17.14L15.29 17.33L14.40 17.51L13.60 17.57L12.80 17.46L11.47 16.70L10.40 16.45L7.20 16.44L6.93 16.58L6.82 16.80L6.82 18.67L6.93 18.93L7.20 19.04L12.27 19.02L13.33 18.80L14.67 18.27L14.93 18.26L15.12 18.40L14.67 18.59L13.60 19.33L12.53 19.86L11.47 20.06L7.20 20.06L6.93 20.11L6.81 20.27L6.81 22.40L6.93 22.54L7.20 22.57L10.13 22.56L10.32 22.67L10.41 22.93L10.38 24.53L10.45 24.80L10.67 24.93L14.13 24.89L14.23 24.80L14.27 24.53L14.29 21.07L14.53 20.53L14.91 20.00L15.47 19.60L16.00 19.38L19.73 19.34L20.53 19.26L21.33 19.04L21.87 18.80L22.40 18.52L23.20 17.94L23.80 17.33L24.39 16.53L24.91 15.47L25.19 14.40L25.18 12.27L24.90 11.20L24.72 10.93L24.66 10.67L24.37 10.13L23.76 9.33L23.20 8.75L22.40 8.14L21.33 7.61L20.53 7.36L19.20 7.27L10.67 7.27Z";

/**
 * Taille minimale d'affichage, en pixels.
 *
 * En dessous, le contre-poinçon se referme et les trois traits se confondent :
 * le symbole devient une tache. Mesuré sur l'aperçu : à 16 px les traits sont
 * déjà collés, à 20 px ils restent distincts. On borne donc plutôt que de
 * laisser un appelant réduire le symbole jusqu'à l'illisible — et on le borne
 * SANS déformer, la géométrie ne changeant jamais.
 */
export const BRAND_MARK_MIN_PX = 20;

type BrandMarkProps = {
  /** Côté du carré, en pixels. Ramené à `BRAND_MARK_MIN_PX` si inférieur. */
  size?: number;
  className?: string;
  /**
   * Nom accessible. Par défaut le symbole est décoratif (`aria-hidden`) :
   * dans la quasi-totalité des emplacements, le mot « POSTYNC » figure juste à
   * côté en texte, et l'annoncer deux fois serait du bruit.
   */
  title?: string;
};

export function BrandMark({ size = 24, className = "", title }: BrandMarkProps) {
  const cote = Math.max(size, BRAND_MARK_MIN_PX);
  const decoratif = title === undefined;

  return (
    <svg
      width={cote}
      height={cote}
      viewBox="0 0 32 32"
      className={`shrink-0 ${className}`.trim()}
      role={decoratif ? undefined : "img"}
      aria-hidden={decoratif ? "true" : undefined}
      aria-label={decoratif ? undefined : title}
      focusable="false"
    >
      {/* Vignette : fond blanc plein, contour noir fin. */}
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="7"
        fill="#ffffff"
        stroke="#09090b"
        strokeWidth="1.5"
      />
      <path d={CONTOUR} fill="#09090b" fillRule="evenodd" />
    </svg>
  );
}
