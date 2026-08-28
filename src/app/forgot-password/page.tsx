import type { Metadata } from "next";
import { connection } from "next/server";

import { AuthShell } from "@/components/layout/auth-shell";
import { FormAlert } from "@/components/ui/form-alert";
import { ForgotPasswordForm } from "@/features/auth/password-forms";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata: Metadata = {
  title: "Mot de passe oublié — POSTYNC",
  robots: { index: false, follow: false },
};

export default async function ForgotPasswordPage() {
  await connection();

  return (
    <AuthShell title="Mot de passe oublié">
      <div className="mb-4 empty:mb-0">
        {isSupabaseConfigured() ? null : (
          <FormAlert tone="error">
            Supabase n&apos;est pas configuré sur cette installation.
          </FormAlert>
        )}
      </div>
      <ForgotPasswordForm />
    </AuthShell>
  );
}
