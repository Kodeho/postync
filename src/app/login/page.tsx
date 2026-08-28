import type { Metadata } from "next";
import { connection } from "next/server";

import { AuthShell } from "@/components/layout/auth-shell";
import { FormAlert } from "@/components/ui/form-alert";
import { LoginForm } from "@/features/auth/login-form";
import { safeReturnPath } from "@/lib/return-path";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata: Metadata = {
  title: "Connexion — POSTYNC",
};

/** Messages renvoyés par `/auth/callback`, jamais du texte brut d'URL. */
const CALLBACK_ERRORS: Record<string, string> = {
  confirmation:
    "Ce lien de confirmation est invalide ou a expiré. Demandez-en un nouveau en vous inscrivant à nouveau.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  // Empêche le prérendu au build : la page dépend de la session courante.
  await connection();

  const params = await searchParams;
  const rawError = params.error;
  const callbackError =
    typeof rawError === "string" ? CALLBACK_ERRORS[rawError] : undefined;

  return (
    <AuthShell title="Se connecter">
      <div className="mb-4 flex flex-col gap-3 empty:mb-0">
        {isSupabaseConfigured() ? null : (
          <FormAlert tone="error">
            Supabase n&apos;est pas configuré. Renseignez{" "}
            <code>.env.local</code> avant de vous connecter.
          </FormAlert>
        )}
        {callbackError ? (
          <FormAlert tone="error">{callbackError}</FormAlert>
        ) : null}
      </div>
      <LoginForm next={safeReturnPath(typeof params.next === "string" ? params.next : null, "")} />
    </AuthShell>
  );
}
