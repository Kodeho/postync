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
        <p className="text-sm opacity-80">
          <Link href="/login" className="underline underline-offset-4">
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

      <SubmitButton label="Créer mon compte" pendingLabel="Création…" />

      <p className="text-sm opacity-80">
        Déjà un compte ?{" "}
        <Link href="/login" className="underline underline-offset-4">
          Se connecter
        </Link>
      </p>
    </form>
  );
}
