import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { Spinner } from "./spinner";

/**
 * Boutons — charte noir et blanc.
 *
 *   primaire   : fond NOIR, texte blanc ;
 *   secondaire : fond BLANC, texte et bordure noirs ;
 *   fantôme    : sans fond ni bordure, pour les actions de troisième rang ;
 *   danger     : réservé à ce qui détruit. Ce n'est pas de la décoration —
 *                une suppression doit se distinguer d'une validation.
 *
 * SUR DU NOIR, LE SURVOL ÉCLAIRCIT. Assombrir un bouton déjà noir ne produirait
 * aucun retour visible ; `--primary-hover` et `--primary-active` montent donc
 * vers le gris foncé. L'enfoncement se distingue du survol, ce qui donne trois
 * états lisibles au lieu de deux.
 *
 * Le focus est traité globalement (`:focus-visible` dans `globals.css`) : un
 * anneau identique partout vaut mieux qu'un anneau par composant.
 */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const BASE =
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium " +
  "transition-colors duration-150 " +
  // Désactivé ET occupé se ressemblent volontairement : dans les deux cas le
  // bouton n'accepte rien. L'opacité descend assez bas pour que ce soit lisible
  // au premier coup d'œil, sans passer sous le seuil de contraste du texte.
  "disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-foreground shadow-soft " +
    "enabled:hover:bg-primary-hover enabled:active:bg-primary-active",
  secondary:
    "border border-foreground bg-surface text-foreground " +
    "enabled:hover:bg-surface-muted enabled:active:bg-border",
  ghost: "text-foreground enabled:hover:bg-surface-muted",
  danger:
    "bg-danger text-primary-foreground shadow-soft enabled:hover:opacity-90",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
};

/** Classes partagées : un bouton et un lien-bouton doivent se ressembler. */
export function buttonClasses(
  variant: Variant = "primary",
  size: Size = "md",
  extra = "",
): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`.trim();
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: Variant;
  size?: Size;
  /**
   * Occupé. Désactive le bouton, pose `aria-busy` et affiche le témoin — d'un
   * seul geste, pour qu'on ne puisse pas obtenir un bouton qui tourne mais
   * reste cliquable.
   */
  loading?: boolean;
  /** Libellé de remplacement pendant l'attente. Sinon l'enfant est conservé. */
  loadingLabel?: string;
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  loading = false,
  loadingLabel,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner /> : null}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}

type ButtonLinkProps = {
  href: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
};

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className = "",
  children,
}: ButtonLinkProps) {
  return (
    <Link href={href} className={buttonClasses(variant, size, className)}>
      {children}
    </Link>
  );
}
