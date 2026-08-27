"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";

import { signUpAction } from "./actions";
import { SignupFields } from "./signup-fields";
import { EMPTY_AUTH_STATE } from "./state";

export function SignupForm() {
  const [state, formAction] = useActionState(signUpAction, EMPTY_AUTH_STATE);

  if (state.notice) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="notice">{state.notice}</FormAlert>
        <p className="text-sm text-muted">
          <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
            Retour à la connexion
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}

      <SignupFields values={state.values} />

      {/*
        L'acceptation est portee par l'acte de creation lui-meme, et annoncee
        AVANT le bouton d'envoi : un utilisateur doit pouvoir lire ce qu'il
        accepte avant de s'engager, pas le decouvrir apres coup.
      */}
      <p className="text-xs text-muted">
        En créant un compte, vous acceptez les{" "}
        <Link href="/terms" className="text-primary underline-offset-4 hover:underline">
          conditions d&apos;utilisation
        </Link>{" "}
        et la{" "}
        <Link href="/privacy" className="text-primary underline-offset-4 hover:underline">
          politique de confidentialité
        </Link>
        .
      </p>

      <SubmitButton label="Créer mon compte" pendingLabel="Création…" />

      <p className="text-sm text-muted">
        Déjà un compte ?{" "}
        <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          Se connecter
        </Link>
      </p>
    </form>
  );
}
