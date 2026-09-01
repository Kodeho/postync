"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { recordLegalAcceptance } from "@/server/legal/acceptance";

// L'état vit dans `accept-state.ts`, et NON ici : un module `"use server"` ne
// peut exporter que des fonctions asynchrones. Voir l'en-tête de ce fichier —
// l'exporter d'ici a mis la production en échec au premier envoi.
import type { LegalAcceptState } from "./accept-state";

/**
 * Enregistre l'acceptation des versions courantes pour l'utilisateur CONNECTÉ.
 *
 * L'identifiant vient de la SESSION, jamais du formulaire. C'est ce qui rend
 * impossible d'accepter à la place d'un autre : le champ n'existe pas, donc
 * il n'y a rien à falsifier. Les versions viennent du serveur pour la même
 * raison — un formulaire qui annoncerait sa propre version pourrait prétendre
 * accepter un document qui n'a jamais été affiché.
 */
export async function acceptLegalAction(
  _prev: LegalAcceptState,
  formData: FormData,
): Promise<LegalAcceptState> {
  if (!isSupabaseConfigured()) {
    return { error: "L'application n'est pas encore configurée sur cette installation." };
  }

  // Même contrôle qu'à l'inscription : la case porte `required`, ce qui ne
  // protège que d'un oubli. Le refus réel est ici.
  if (String(formData.get("legalAccepted") ?? "") !== "on") {
    return {
      error:
        "Vous devez accepter les conditions d'utilisation et la politique de confidentialité pour continuer.",
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const trace = await recordLegalAcceptance(user.id);
  if (!trace.ok) {
    return { error: "L'enregistrement a échoué. Veuillez réessayer." };
  }

  revalidatePath("/", "layout");
  redirect("/app");
}
