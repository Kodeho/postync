import type { Metadata } from "next";
import { connection } from "next/server";

import { AuthShell } from "@/components/layout/auth-shell";
import { FormAlert } from "@/components/ui/form-alert";
import { SignupForm } from "@/features/auth/signup-form";
import { safeReturnPath } from "@/lib/return-path";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata: Metadata = {
  title: "Créer un compte — POSTYNC",
};

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  await connection();

  const params = await searchParams;
  const next = safeReturnPath(typeof params.next === "string" ? params.next : null, "");

  return (
    <AuthShell title="Créer un compte">
      {isSupabaseConfigured() ? null : (
        <div className="mb-4">
          <FormAlert tone="error">
            Supabase n&apos;est pas configuré. Renseignez{" "}
            <code>.env.local</code> avant de créer un compte.
          </FormAlert>
        </div>
      )}
      <SignupForm next={next} />
    </AuthShell>
  );
}
