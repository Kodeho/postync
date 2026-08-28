import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { AuthShell } from "@/components/layout/auth-shell";
import { FormAlert } from "@/components/ui/form-alert";
import { ResetPasswordForm } from "@/features/auth/password-forms";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata: Metadata = {
  title: "Nouveau mot de passe — POSTYNC",
  robots: { index: false, follow: false },
};

/**
 * Choix du nouveau mot de passe (C15).
 *
 * On n'arrive ici qu'AVEC une session : le lien de réinitialisation en ouvre
 * une en passant par `/auth/callback`. Sans session, la page ne montre pas un
 * formulaire inutilisable — elle explique et renvoie demander un lien neuf,
 * ce qui est la seule action utile à ce stade.
 *
 * Pas de `requireUser()` ici, volontairement : cette page doit rester lisible
 * pour quelqu'un dont le lien a expiré, et non le rediriger vers `/login` où
 * il ne comprendrait pas ce qui vient de se passer.
 */
export default async function ResetPasswordPage() {
  await connection();

  let hasSession = false;
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    hasSession = user !== null;
  }

  return (
    <AuthShell title="Nouveau mot de passe">
      {hasSession ? (
        <ResetPasswordForm />
      ) : (
        <div className="flex flex-col gap-4">
          <FormAlert tone="error">
            Ce lien de réinitialisation est invalide, a déjà servi, ou a été ouvert
            depuis un autre navigateur que celui qui l&apos;a demandé.
          </FormAlert>
          <p className="text-sm text-muted">
            <Link
              href="/forgot-password"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Demander un nouveau lien
            </Link>
          </p>
        </div>
      )}
    </AuthShell>
  );
}
