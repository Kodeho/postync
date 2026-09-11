"use client";

import { useFormStatus } from "react-dom";

import { buttonClasses } from "./button";
import { Spinner } from "./spinner";

/**
 * Bouton de soumission d'un formulaire d'action serveur.
 *
 * IL NE REDÉFINIT PLUS SON APPARENCE. Il recopiait auparavant les classes du
 * bouton primaire ; deux définitions du même bouton finissent toujours par
 * diverger, et c'est précisément ce qui serait arrivé au passage à la charte
 * noir et blanc — l'un aurait changé, l'autre non. Il appelle désormais
 * `buttonClasses`, comme tout le monde.
 *
 * `useFormStatus` doit être lu DANS un composant enfant du `<form>` : c'est la
 * raison d'être de ce composant séparé, et la raison pour laquelle il porte
 * lui-même l'état occupé plutôt que de le recevoir en propriété.
 */
type SubmitButtonProps = {
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md";
  className?: string;
  /** Désactivation décidée par l'appelant, indépendante de l'envoi en cours. */
  disabled?: boolean;
};

export function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
  size = "md",
  className = "",
  disabled = false,
}: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      className={buttonClasses(variant, size, className)}
    >
      {pending ? <Spinner /> : null}
      {pending ? pendingLabel : label}
    </button>
  );
}
