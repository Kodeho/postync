"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { TextField } from "@/components/ui/text-field";

import { signInAction } from "./actions";
import { EMPTY_AUTH_STATE } from "./state";

export function LoginForm() {
  const [state, formAction] = useActionState(signInAction, EMPTY_AUTH_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}

      <TextField
        label="Adresse e-mail"
        name="email"
        type="email"
        autoComplete="email"
      />
      <TextField
        label="Mot de passe"
        name="password"
        type="password"
        autoComplete="current-password"
      />

      <SubmitButton label="Se connecter" pendingLabel="Connexion…" />

      <p className="text-sm opacity-80">
        Pas encore de compte ?{" "}
        <Link href="/signup" className="underline underline-offset-4">
          Créer un compte
        </Link>
      </p>
    </form>
  );
}
