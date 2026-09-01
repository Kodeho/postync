"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";

import { signUpAction } from "./actions";
import { SignupFields } from "./signup-fields";
import { EMPTY_AUTH_STATE } from "./state";

export function SignupForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState(signUpAction, EMPTY_AUTH_STATE);

  if (state.notice) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="notice">{state.notice}</FormAlert>
        <p className="text-sm text-muted">
          <Link href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"} className="font-medium text-primary underline-offset-4 hover:underline">
            Retour à la connexion
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}

      <SignupFields values={state.values} />

      {/*
        ACCEPTATION EXPLICITE, et tracee.

        Elle etait auparavant portee par l'acte de creation lui-meme — licite,
        mais rien n'en gardait la preuve. Une case est desormais requise, et
        son etat est verifie cote serveur : `validateSignup` refuse
        l'inscription sans elle, meme si le formulaire est poste directement.

        TROIS CHOIX DELIBERES :

        · la case n'est PAS pre-cochee. Une case pre-cochee n'est pas un
          consentement, c'est une case pre-cochee ;
        · le texte dit ce qui est accepte, sans emballage ni incitation. Aucun
          avantage n'est promis en echange, aucune formulation ne suggere que
          refuser serait anormal ;
        · les liens s'ouvrent dans un NOUVEL onglet. Naviguer dans le meme
          onglet ferait perdre le mot de passe deja saisi, et l'utilisateur
          renoncerait a lire plutot qu'a tout ressaisir — un obstacle a la
          lecture est un dark pattern, meme involontaire.
      */}
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          id="legalAccepted"
          name="legalAccepted"
          required
          aria-describedby="legalAccepted-aide"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-primary"
        />
        <label htmlFor="legalAccepted" className="text-xs text-muted">
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
          <span id="legalAccepted-aide" className="text-muted-soft">
            Les deux s&apos;ouvrent dans un nouvel onglet : votre saisie est conservée.
          </span>
        </label>
      </div>

      <SubmitButton label="Créer mon compte" pendingLabel="Création…" />

      <p className="text-sm text-muted">
        Déjà un compte ?{" "}
        <Link href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"} className="font-medium text-primary underline-offset-4 hover:underline">
          Se connecter
        </Link>
      </p>
    </form>
  );
}
