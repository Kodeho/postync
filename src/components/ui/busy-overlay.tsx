"use client";

import { useEffect, useRef } from "react";

import { BrandLogo } from "./brand-logo";
import { Button } from "./button";
import { Progress } from "./progress";
import { Spinner } from "./spinner";

/**
 * Surcouche bloquante — téléversement, publication, et tout traitement qu'on
 * ne doit pas interrompre.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI BLOQUER PLUTÔT QU'AFFICHER UN TÉMOIN DANS UN COIN
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Un envoi vidéo dure. Pendant ce temps, l'utilisateur peut cliquer une
 * seconde fois, changer d'écran, ou fermer l'onglet — et selon le moment, cela
 * produit une publication en double, une session d'envoi orpheline, ou un
 * fichier à moitié transféré. La surcouche supprime ces trois possibilités
 * d'un seul geste : elle couvre la page, donc plus rien derrière n'est
 * cliquable, et elle pose un avertissement de fermeture.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QU'ELLE NE FAIT JAMAIS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Elle n'invente pas de progression. `progress` n'est passé que lorsqu'une
 * mesure existe réellement (octets envoyés / octets totaux). Sinon la barre est
 * indéterminée et seul le NOM de l'étape avance — voir `progress.tsx`.
 *
 * Elle n'offre pas d'annulation décorative. `onCancel` n'est branché que là où
 * l'interruption est réellement possible et propre ; sans lui, ni bouton, ni
 * Échap, ni clic sur le fond ne ferment quoi que ce soit. Proposer « Annuler »
 * sur une opération qu'on ne sait pas défaire serait un mensonge de plus.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ACCESSIBILITÉ
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `role="dialog"` + `aria-modal` : le reste de la page est hors du parcours.
 * Le focus entre à l'ouverture et reste piégé (Tab et Maj+Tab bouclent), puis
 * revient à l'élément qui l'avait avant. Le libellé d'étape vit dans une région
 * `aria-live="polite"` : il est annoncé quand il change, sans interrompre.
 * Le mouvement réduit est traité dans `globals.css`.
 */

const SELECTEUR_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export type BusyOverlayProps = {
  open: boolean;
  /** Ce qui se passe, en une ligne. Ex. « Envoi de votre vidéo ». */
  title: string;
  /** L'étape RÉELLE en cours. Ex. « Téléversement du fichier ». */
  stepLabel: string;
  /**
   * Pourcentage MESURÉ, 0 à 100. À omettre dès qu'il n'est pas mesuré : la
   * barre devient alors indéterminée.
   */
  progress?: number;
  /** Message d'échec. Non nul = l'opération est terminée, et elle a échoué. */
  error?: string | null;
  /** Proposé après un échec, quand rejouer a un sens. */
  onRetry?: () => void;
  /**
   * Libellé du bouton de reprise. À ne personnaliser que si l'opération
   * REPREND réellement là où elle s'est arrêtée : promettre « Reprendre » à
   * une opération qui recommence de zéro serait un mensonge d'interface.
   */
  retryLabel?: string;
  /** Ferme la surcouche après un échec. Obligatoire si `error` peut survenir. */
  onDismiss?: () => void;
  /** Annulation RÉELLE. Absent = aucune annulation n'est proposée. */
  onCancel?: () => void;
  cancelLabel?: string;
};

export function BusyOverlay({
  open,
  title,
  stepLabel,
  progress,
  error = null,
  onRetry,
  retryLabel = "Réessayer",
  onDismiss,
  onCancel,
  cancelLabel = "Annuler l'envoi",
}: BusyOverlayProps) {
  const panneau = useRef<HTMLDivElement>(null);
  const focusPrecedent = useRef<HTMLElement | null>(null);
  /** Une opération est en vol tant qu'elle n'a pas échoué. */
  const enVol = open && !error;

  // Défilement de l'arrière-plan : coupé. Sans cela, la molette continue de
  // faire défiler la page sous la surcouche, ce qui donne l'impression qu'on
  // peut encore agir.
  useEffect(() => {
    if (!open) return;
    const precedent = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = precedent;
    };
  }, [open]);

  // AVERTISSEMENT AVANT FERMETURE. Uniquement pendant que l'opération est en
  // vol : après un échec, il n'y a plus rien à perdre et insister serait
  // pénible. Le navigateur affiche son propre texte, on ne le choisit pas.
  useEffect(() => {
    if (!enVol) return;
    const avertir = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Requis par certains navigateurs pour déclencher la confirmation.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", avertir);
    return () => window.removeEventListener("beforeunload", avertir);
  }, [enVol]);

  // Focus : entrée, piégeage, restitution.
  useEffect(() => {
    if (!open) return;
    focusPrecedent.current = document.activeElement as HTMLElement | null;
    panneau.current?.focus();

    const auClavier = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Échap n'annule que si l'annulation existe VRAIMENT.
        if (onCancel) {
          event.preventDefault();
          onCancel();
        } else if (error && onDismiss) {
          event.preventDefault();
          onDismiss();
        }
        return;
      }
      if (event.key !== "Tab" || !panneau.current) return;

      const cibles = Array.from(
        panneau.current.querySelectorAll<HTMLElement>(SELECTEUR_FOCUSABLE),
      );
      // Aucun élément focusable — c'est le cas nominal pendant un envoi non
      // annulable : le focus reste sur le panneau, et Tab ne s'en échappe pas.
      if (cibles.length === 0) {
        event.preventDefault();
        panneau.current.focus();
        return;
      }
      const premier = cibles[0];
      const dernier = cibles[cibles.length - 1];
      if (event.shiftKey && document.activeElement === premier) {
        event.preventDefault();
        dernier.focus();
      } else if (!event.shiftKey && document.activeElement === dernier) {
        event.preventDefault();
        premier.focus();
      }
    };

    document.addEventListener("keydown", auClavier, true);
    return () => {
      document.removeEventListener("keydown", auClavier, true);
      focusPrecedent.current?.focus?.();
    };
  }, [open, onCancel, onDismiss, error]);

  if (!open) return null;

  return (
    <div
      className="postync-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      // Le fond capte aussi les clics : rien derrière n'est atteignable, même
      // en visant la zone sombre.
      style={{
        backgroundColor: "var(--overlay-backdrop)",
        backdropFilter: `blur(var(--overlay-blur))`,
        WebkitBackdropFilter: `blur(var(--overlay-blur))`,
      }}
    >
      <div
        ref={panneau}
        role="dialog"
        aria-modal="true"
        aria-labelledby="busy-overlay-titre"
        tabIndex={-1}
        className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-pop outline-none"
      >
        <div className="flex flex-col items-center gap-5 text-center">
          <BrandLogo size="md" />

          <div className="flex flex-col gap-1">
            <h2 id="busy-overlay-titre" className="text-base font-semibold text-foreground">
              {title}
            </h2>

            {/*
              Région vivante : c'est ici, et nulle part ailleurs, que l'étape
              est annoncée. `polite` plutôt qu'`assertive` — l'information est
              utile, elle n'est pas urgente au point d'interrompre.
            */}
            <p aria-live="polite" className="min-h-5 text-sm text-muted">
              {error ? null : stepLabel}
            </p>
          </div>

          {error ? (
            <div className="flex w-full flex-col gap-4">
              <p
                role="alert"
                className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger"
              >
                {error}
              </p>
              <div className="flex justify-center gap-2">
                {onRetry ? (
                  <Button variant="primary" size="sm" onClick={onRetry}>
                    {retryLabel}
                  </Button>
                ) : null}
                {onDismiss ? (
                  <Button variant="secondary" size="sm" onClick={onDismiss}>
                    Fermer
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex w-full flex-col gap-4">
              <div className="flex items-center gap-3">
                <Spinner size={18} className="text-foreground" />
                <Progress
                  value={progress}
                  label={stepLabel}
                  className="flex-1"
                />
                {/* Le pourcentage n'apparaît QUE s'il est mesuré. */}
                {typeof progress === "number" ? (
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted">
                    {Math.round(progress)}%
                  </span>
                ) : null}
              </div>

              <p className="text-xs text-muted">
                Gardez cette page ouverte jusqu&apos;à la fin de l&apos;opération.
              </p>

              {onCancel ? (
                <Button variant="secondary" size="sm" onClick={onCancel} className="self-center">
                  {cancelLabel}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
