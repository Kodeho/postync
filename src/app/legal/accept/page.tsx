import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { PRODUCT_NAME } from "@/config/product";
import { PUBLISHER } from "@/config/legal";
import { signOutAction } from "@/features/auth/actions";
import { LegalAcceptForm } from "@/features/legal/accept-form";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { hasAcceptedCurrentLegalVersions } from "@/server/legal/acceptance";

export const metadata = { title: "Documents à accepter" };

/**
 * Écran de réacceptation.
 *
 * IL N'APPELLE PAS LA GARDE, sous peine de boucle : c'est la destination de
 * la redirection. Il refait donc lui-même les deux contrôles dont il a
 * besoin — une session, et l'absence d'acceptation courante.
 *
 * CE QUI RESTE ACCESSIBLE DEPUIS ICI, et c'est le cœur du sujet : les deux
 * documents, la déconnexion, et l'adresse par laquelle demander la
 * suppression du compte. Un utilisateur qui refuse n'est pas piégé — il peut
 * lire, partir, ou faire effacer ses données. Bloquer ces issues transformerait
 * un consentement en extorsion.
 */
export default async function LegalAcceptPage() {
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

  // Déjà à jour : rien à demander. Évite qu'un lien direct ou un retour
  // arrière ne présente un écran sans objet.
  if (await hasAcceptedCurrentLegalVersions(supabase, user.id)) {
    redirect("/app");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 px-6 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Nos documents ont changé
        </h1>
        <p className="text-sm text-muted">
          Pour continuer à utiliser {PRODUCT_NAME}, merci de prendre connaissance des conditions
          d&apos;utilisation et de la politique de confidentialité, puis de les accepter. Nous
          conservons la date de votre acceptation et la version acceptée — rien d&apos;autre.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-surface p-5">
        <LegalAcceptForm />
      </div>

      <div className="flex flex-col gap-3 text-xs text-muted">
        <p>
          Vous préférez ne pas accepter ? Vous pouvez vous déconnecter, ou demander la suppression
          complète de votre compte et de ses données en écrivant à{" "}
          <a
            href={`mailto:${PUBLISHER.contactEmail}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {PUBLISHER.contactEmail}
          </a>{" "}
          depuis l&apos;adresse du compte concerné.
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link href="/terms" className="underline-offset-4 hover:underline">
            Conditions d&apos;utilisation
          </Link>
          <Link href="/privacy" className="underline-offset-4 hover:underline">
            Politique de confidentialité
          </Link>
          <form action={signOutAction}>
            <button type="submit" className="underline-offset-4 hover:underline">
              Se déconnecter
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
