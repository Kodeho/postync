"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { TextField } from "@/components/ui/text-field";

import {
  changePasswordAction,
  requestPasswordResetAction,
  updatePasswordAction,
} from "./actions";
import { EMPTY_AUTH_STATE } from "./state";
import { PASSWORD_MIN_LENGTH } from "./validation";

/**
 * Récupération de mot de passe (C15).
 *
 * Sans elle, un client qui oublie son mot de passe est définitivement enfermé
 * dehors : ses workspaces, ses comptes sociaux connectés et ses publications
 * programmées continuent d'exister sans que personne puisse y accéder.
 *
 * L'e-mail est envoyé par Supabase Auth, comme la confirmation d'inscription.
 * Aucun fournisseur tiers n'intervient à ce stade.
 */

/** Demande d'un lien de réinitialisation. */
export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(
    requestPasswordResetAction,
    EMPTY_AUTH_STATE,
  );

  // Une fois la demande envoyée, le formulaire disparaît : le réafficher
  // inviterait à recommencer, ce que les limites de débit refuseront.
  if (state.notice) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="notice">{state.notice}</FormAlert>
        <p className="text-sm text-muted">
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
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
        label="Adresse e-mail"
        name="email"
        type="email"
        autoComplete="email"
        hint="Celle de votre compte POSTYNC."
      />

      <SubmitButton label="Envoyer le lien" pendingLabel="Envoi…" />

      <p className="text-sm text-muted">
        Vous vous en souvenez ?{" "}
        <Link
          href="/login"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Se connecter
        </Link>
      </p>
    </form>
  );
}

/** Choix du nouveau mot de passe, après ouverture du lien reçu. */
export function ResetPasswordForm() {
  const [state, formAction] = useActionState(updatePasswordAction, EMPTY_AUTH_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}

      <TextField
        label="Nouveau mot de passe"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        hint={`${PASSWORD_MIN_LENGTH} caractères minimum.`}
      />
      <TextField
        label="Confirmer le mot de passe"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
      />

      <SubmitButton label="Changer le mot de passe" pendingLabel="Enregistrement…" />

      <p className="text-xs text-muted">
        Vos autres sessions ouvertes seront fermées.
      </p>
    </form>
  );
}

/**
 * Changement de mot de passe depuis les paramètres, en étant connecté.
 *
 * Le mot de passe ACTUEL est demandé. Sans lui, une session laissée ouverte
 * sur un poste partagé suffirait à s'approprier le compte définitivement.
 */
export function ChangePasswordForm() {
  const [state, formAction] = useActionState(changePasswordAction, EMPTY_AUTH_STATE);

  return (
    <form action={formAction} className="mt-4 flex max-w-md flex-col gap-4">
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
      {state.notice ? <FormAlert tone="notice">{state.notice}</FormAlert> : null}

      <TextField
        label="Mot de passe actuel"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
      />
      <TextField
        label="Nouveau mot de passe"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        hint={`${PASSWORD_MIN_LENGTH} caractères minimum.`}
      />
      <TextField
        label="Confirmer le nouveau mot de passe"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
      />

      <div className="flex items-center gap-3">
        <SubmitButton label="Changer le mot de passe" pendingLabel="Enregistrement…" />
      </div>
      <p className="text-xs text-muted">
        Vos autres sessions ouvertes seront fermées ; celle-ci restera active.
      </p>
    </form>
  );
}
