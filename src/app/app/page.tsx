import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { PRODUCT_NAME } from "@/config/product";
import { signOutAction } from "@/features/auth/actions";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Mon espace — POSTYNC",
};

export default async function PrivateAreaPage() {
  await connection();

  if (!isSupabaseConfigured()) {
    redirect("/login");
  }

  const supabase = await createClient();

  // Contrôle d'accès faisant autorité.
  //
  // Le Proxy protège déjà cette route, mais il ne doit JAMAIS être l'unique
  // barrière : une requête forgée qui contournerait le Proxy atteindrait
  // directement ce composant. `getUser()` revalide le jeton auprès du serveur
  // d'authentification Supabase, contrairement à `getSession()`.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // RLS restreint déjà cette lecture au profil de l'utilisateur courant.
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();

  const displayName = profile?.display_name?.trim();
  const label = displayName && displayName.length > 0 ? displayName : user.email;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">{PRODUCT_NAME}</h1>

      <p className="text-lg">Bienvenue, {label}</p>

      <p className="text-sm opacity-70">Votre espace privé est actif.</p>

      <form action={signOutAction}>
        <button
          type="submit"
          className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80 dark:border-white/20"
        >
          Se déconnecter
        </button>
      </form>
    </main>
  );
}
