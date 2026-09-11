import Link from "next/link";

import { PRODUCT_NAME } from "@/config/product";

import { BrandMark } from "./brand-mark";

/**
 * Signature de marque — un seul composant, tous les emplacements.
 *
 * La marque était du TEXTE BRUT répété dans la barre latérale, l'écran
 * d'authentification, les pages légales, la console d'administration et
 * l'accueil public : cinq tailles, cinq graisses, aucune cohérence possible.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LE LOGO EST LE MONOGRAMME SEUL
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `BrandMark` ne contient QUE la lettre P : pas de texte incorporé, pas de
 * second symbole, pas de dégradé. Le mot « POSTYNC » qui l'accompagne ici
 * n'appartient pas au logo — c'est du texte ordinaire, posé à côté, qui rend
 * le produit identifiable là où un P nu serait muet.
 *
 * D'où la séparation des deux : `markOnly` retire le mot sans jamais toucher
 * au symbole, et aucun appelant ne peut fabriquer une variante du symbole.
 *
 * Le PNG en dégradé bleu-violet récupéré du branding Google a été retiré : il
 * portait un fond sombre incrusté, n'existait qu'en 120 px et ne pouvait pas
 * se décliner en monochrome.
 */

type Size = "sm" | "md" | "lg";

/** Jamais sous `BRAND_MARK_MIN_PX` : en dessous, l'œil du P se referme. */
const SYMBOLE: Record<Size, number> = { sm: 20, md: 24, lg: 40 };
const MOT: Record<Size, string> = {
  sm: "text-sm tracking-tight",
  md: "text-base tracking-tight",
  lg: "text-2xl tracking-tight",
};
/** L'écart suit la taille : un symbole plus grand demande plus d'air. */
const ECART: Record<Size, string> = { sm: "gap-2", md: "gap-2.5", lg: "gap-3" };

type BrandLogoProps = {
  size?: Size;
  /** `light` = sur fond clair (mot noir). `dark` = sur fond sombre (mot blanc). */
  tone?: "light" | "dark";
  /** Le symbole seul, sans le nom du produit à côté. */
  markOnly?: boolean;
  /** Rend l'ensemble cliquable vers cette destination. */
  href?: string;
  className?: string;
};

export function BrandLogo({
  size = "md",
  tone = "light",
  markOnly = false,
  href,
  className = "",
}: BrandLogoProps) {
  const couleurMot = tone === "dark" ? "text-white" : "text-foreground";

  const contenu = (
    <span className={`inline-flex items-center ${ECART[size]} ${className}`.trim()}>
      {/*
        Le symbole est décoratif quand le mot l'accompagne — l'annoncer en plus
        ferait entendre « POSTYNC POSTYNC ». Seul, il porte le nom accessible.
      */}
      <BrandMark size={SYMBOLE[size]} title={markOnly ? PRODUCT_NAME : undefined} />
      {markOnly ? null : (
        <span className={`font-semibold ${MOT[size]} ${couleurMot}`}>{PRODUCT_NAME}</span>
      )}
    </span>
  );

  if (!href) return contenu;

  return (
    <Link
      href={href}
      className="inline-flex rounded-sm transition-opacity hover:opacity-80"
      aria-label={PRODUCT_NAME}
    >
      {contenu}
    </Link>
  );
}
