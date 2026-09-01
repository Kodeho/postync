"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";

import { acceptLegalAction, IDLE_LEGAL_ACCEPT } from "./accept-action";

/**
 * Formulaire de réacceptation.
 *
 * Mêmes règles qu'à l'inscription, et pour les mêmes raisons : case NON
 * pré-cochée, texte qui dit ce qui est accepté sans rien promettre en
 * échange, liens ouverts dans un nouvel onglet pour que lire ne coûte pas de
 * repartir de zéro.
 */
export function LegalAcceptForm() {
  const [state, formAction] = useActionState(acceptLegalAction, IDLE_LEGAL_ACCEPT);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}

      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          id="legalAccepted"
          name="legalAccepted"
          required
          aria-describedby="legalAccepted-aide"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-primary"
        />
        <label htmlFor="legalAccepted" className="text-sm text-foreground">
          J&apos;ai lu et j&apos;accepte les{" "}
          <Link
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            conditions d&apos;utilisation
          </Link>{" "}
          et la{" "}
          <Link
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            politique de confidentialité
          </Link>
          .{" "}
          <span id="legalAccepted-aide" className="text-muted">
            Les deux s&apos;ouvrent dans un nouvel onglet.
          </span>
        </label>
      </div>

      <SubmitButton label="Continuer" pendingLabel="Enregistrement…" />
    </form>
  );
}
