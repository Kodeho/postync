"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "./button";

/**
 * Confirmation d'une action irréversible.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUE CETTE BOÎTE EMPÊCHE
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Le clic accidentel, et surtout la validation accidentelle. Trois mesures,
 * chacune contre un geste réel :
 *
 *   · le FOCUS ENTRE SUR « Annuler ». C'est l'action par défaut : la touche
 *     Entrée, réflexe de celui qui enchaîne les formulaires, annule au lieu
 *     de détruire ;
 *   · AUCUN `<form>`. Une boîte construite sur un formulaire valide à la
 *     touche Entrée depuis n'importe quel champ, et c'est précisément ce
 *     qu'on ne veut pas. Les deux boutons sont `type="button"` et n'agissent
 *     que sur un clic ou une activation explicite ;
 *   · ÉCHAP ANNULE, mais seulement AVANT le lancement. Une fois l'opération
 *     partie, la fermer ne l'arrêterait pas — elle donnerait seulement
 *     l'illusion de l'avoir arrêtée.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ELLE NE SE FERME PAS TOUTE SEULE
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `open` reste piloté par l'appelant : la boîte ne disparaît qu'une fois le
 * succès confirmé. En cas d'échec elle RESTE ouverte, affiche la raison, et
 * le bouton devient « Réessayer ». Une boîte qui se referme sur une erreur
 * laisse l'utilisateur croire que c'est fait.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `alertdialog` ET NON `dialog`
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Le rôle `alertdialog` est fait pour les interruptions qui demandent une
 * réponse avant de continuer : les lecteurs d'écran annoncent alors le
 * message décrivant la conséquence, pas seulement le titre.
 */

const SELECTEUR_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export type ConfirmDialogProps = {
  open: boolean;
  /** Titre court. Ex. « Supprimer cette vidéo ? ». */
  title: string;
  /** L'objet concerné, nommé. Affiché en évidence pour lever toute ambiguïté. */
  subject?: string;
  /** Ce que l'action détruit EXACTEMENT, et ce qu'elle épargne. */
  children: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  cancelLabel?: string;
  /** Vrai pendant l'opération : boutons verrouillés, témoin affiché. */
  pending: boolean;
  /** Non nul = l'opération a échoué. La boîte reste ouverte. */
  error?: string | null;
  /**
   * Non nul = l'opération a RÉUSSI. La boîte le dit et n'offre plus que
   * « Fermer ».
   *
   * Pourquoi la confirmation vit ICI plutôt qu'à côté de l'élément supprimé :
   * cet élément vient précisément de disparaître. Un message rendu à sa place
   * serait démonté avec lui, et l'utilisateur ne verrait rien. La boîte, elle,
   * survit jusqu'à ce qu'il la ferme.
   */
  success?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  subject,
  children,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Annuler",
  pending,
  error = null,
  success = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panneau = useRef<HTMLDivElement>(null);
  const annuler = useRef<HTMLButtonElement>(null);

  // Défilement de l'arrière-plan coupé : sans cela, la molette continue de
  // faire défiler la page derrière, ce qui suggère qu'on peut encore agir.
  useEffect(() => {
    if (!open) return;
    const precedent = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = precedent;
    };
  }, [open]);

  // Focus : entrée sur « Annuler », piégeage, restitution à la fermeture.
  useEffect(() => {
    if (!open) return;
    const precedent = document.activeElement as HTMLElement | null;
    // Sur « Annuler », pas sur le panneau : l'action par défaut doit être
    // celle qui ne détruit rien.
    annuler.current?.focus();

    const auClavier = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Pendant l'opération, Échap ne ferme pas : l'opération continuerait
        // sans que rien ne l'indique.
        if (!pending) {
          event.preventDefault();
          onCancel();
        }
        return;
      }
      if (event.key !== "Tab" || !panneau.current) return;
      const cibles = Array.from(
        panneau.current.querySelectorAll<HTMLElement>(SELECTEUR_FOCUSABLE),
      );
      if (cibles.length === 0) {
        event.preventDefault();
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
      precedent?.focus?.();
    };
  }, [open, pending, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{
        backgroundColor: "var(--overlay-backdrop)",
        backdropFilter: "blur(var(--overlay-blur))",
        WebkitBackdropFilter: "blur(var(--overlay-blur))",
      }}
      // Cliquer à côté annule — mais jamais pendant l'opération.
      onClick={() => {
        if (!pending) onCancel();
      }}
    >
      <div
        ref={panneau}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-titre"
        aria-describedby="confirm-description"
        className="w-full max-w-md rounded-lg bg-surface p-6 shadow-pop"
        // Un clic DANS la boîte ne doit pas être pris pour un clic à côté.
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-titre" className="text-base font-semibold text-foreground">
          {title}
        </h2>

        {subject ? (
          <p className="mt-3 truncate rounded-md border border-border bg-surface-muted px-3 py-2 text-sm font-medium text-foreground">
            {subject}
          </p>
        ) : null}

        <div id="confirm-description" className="mt-3 flex flex-col gap-2 text-sm text-muted">
          {children}
        </div>

        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        ) : null}

        {success ? (
          <p
            role="status"
            className="mt-4 rounded-md border border-success/20 bg-success-soft px-3 py-2 text-sm text-success"
          >
            {success}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          {success ? (
            // Réussi : plus rien à détruire, donc plus de bouton destructeur.
            <Button ref={annuler} variant="secondary" onClick={onCancel}>
              Fermer
            </Button>
          ) : (
            <>
              <Button
                ref={annuler}
                variant="secondary"
                onClick={onCancel}
                disabled={pending}
              >
                {cancelLabel}
              </Button>
              <Button
                variant="danger"
                onClick={onConfirm}
                loading={pending}
                loadingLabel={pendingLabel}
              >
                {error ? "Réessayer" : confirmLabel}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
