"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { TextField } from "@/components/ui/text-field";

import { signUpAction } from "./actions";
import { EMPTY_AUTH_STATE } from "./state";
import { DISPLAY_NAME_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./validation";

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

      <TextField
        label="Nom"
        name="displayName"
        autoComplete="name"
        maxLength={DISPLAY_NAME_MAX_LENGTH}
      />
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
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
      />
      <TextField
        label="Confirmation du mot de passe"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
      />

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
