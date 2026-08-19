import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AuthShell } from "@/components/layout/auth-shell";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { signOutAction } from "@/features/auth/actions";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Compte suspendu — POSTYNC",
};

/**
 * Page affichée à un compte suspendu ou désactivé. Les données ne sont pas
 * supprimées ; seul l'accès est fermé. Un compte actif qui arriverait ici est
 * renvoyé vers /app.
 */
export default async function AccountSuspendedPage() {
  await connection();

  if (!isSupabaseConfigured()) {
    redirect("/login");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("account_status")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || profile.account_status === "active") {
    redirect("/app");
  }

  return (
    <AuthShell title="Accès suspendu">
      <div className="flex flex-col gap-4">
        <FormAlert tone="error">
          Votre compte POSTYNC est actuellement suspendu. Vos données sont
          conservées, mais l&apos;accès à l&apos;application est fermé.
        </FormAlert>
        <p className="text-sm text-muted">
          Si vous pensez qu&apos;il s&apos;agit d&apos;une erreur, contactez le
          support POSTYNC.
        </p>
        <form action={signOutAction}>
          <Button type="submit" variant="secondary">
            Se déconnecter
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}
