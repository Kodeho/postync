/**
 * Témoin d'activité — un seul, partagé.
 *
 * `currentColor` volontairement : le témoin prend la couleur du texte qui
 * l'entoure, donc blanc dans un bouton noir et noir dans un bouton blanc, sans
 * qu'aucun appelant ait à le dire.
 *
 * `aria-hidden` : il ne porte AUCUNE information. Ce qui est annoncé aux
 * technologies d'assistance, c'est le libellé de l'étape, via la région
 * `aria-live` de la surcouche ou le texte du bouton. Un témoin qui tourne n'est
 * pas un message.
 *
 * Le mouvement réduit est traité dans `globals.css` : la rotation y devient une
 * pulsation d'opacité, parce qu'un témoin totalement immobile ne distingue plus
 * « en cours » de « figé ».
 */
type SpinnerProps = {
  /** Diamètre en pixels. 16 dans un bouton, 24 ou plus dans une surcouche. */
  size?: number;
  className?: string;
};

export function Spinner({ size = 16, className = "" }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={`postync-spin shrink-0 ${className}`.trim()}
    >
      {/* Le cercle complet, très atténué : il donne la piste que parcourt l'arc. */}
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      {/* L'arc, opaque : c'est lui qu'on voit tourner. */}
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
