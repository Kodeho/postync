"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { getSiteOrigin } from "@/lib/site-url";

import { toUserMessage } from "./errors";
import type { AuthFormState } from "./state";
import { validateLogin, validateSignup } from "./validation";

const NOT_CONFIGURED_STATE: AuthFormState = {
  error:
    "L'authentification n'est pas encore configurée sur cette installation.",
  notice: null,
};

function failure(error: string): AuthFormState {
  return { error, notice: null };
}

/**
 * Inscription par e-mail et mot de passe.
 *
 * Le profil correspondant est créé par le trigger PostgreSQL
 * `on_auth_user_created` (voir supabase/migrations), jamais depuis le client :
 * cela garantit qu'un utilisateur ne peut pas choisir son `platform_role`.
 */
export async function signUpAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!isSupabaseConfigured()) {
    return NOT_CONFIGURED_STATE;
  }

  const parsed = validateSignup(formData);
  if (!parsed.ok) {
    return failure(parsed.error);
  }

  const { displayName, email, password } = parsed.value;
  let hasSession = false;

  try {
    const supabase = await createClient();
    const origin = await getSiteOrigin();

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Repris par le trigger pour pré-remplir `profiles.display_name`.
        data: { display_name: displayName },
        emailRedirectTo: `${origin}/auth/callback`,
      },
    });

    if (error) {
      return failure(toUserMessage(error, "signup"));
    }

    // Lorsque la confirmation d'e-mail est active, Supabase renvoie un
    // utilisateur factice sans identité pour une adresse déjà inscrite.
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
      return failure("Cette adresse e-mail est déjà utilisée.");
    }

    hasSession = data.session !== null;
  } catch (error) {
    return failure(toUserMessage(error, "signup"));
  }

  if (!hasSession) {
    return {
      error: null,
      notice:
        "Compte créé. Un e-mail de confirmation vous a été envoyé : cliquez sur le lien qu'il contient pour activer votre compte.",
    };
  }

  revalidatePath("/", "layout");
  redirect("/app");
}

/** Connexion par e-mail et mot de passe. */
export async function signInAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!isSupabaseConfigured()) {
    return NOT_CONFIGURED_STATE;
  }

  const parsed = validateLogin(formData);
  if (!parsed.ok) {
    return failure(parsed.error);
  }

  const { email, password } = parsed.value;

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return failure(toUserMessage(error, "login"));
    }
  } catch (error) {
    return failure(toUserMessage(error, "login"));
  }

  revalidatePath("/", "layout");
  redirect("/app");
}

/**
 * Déconnexion.
 *
 * `signOut()` révoque la session côté Supabase ; le client serveur retire
 * ensuite les cookies d'authentification via `setAll`.
 */
export async function signOutAction(): Promise<void> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = await createClient();
      await supabase.auth.signOut();
    } catch (error) {
      // Une session déjà invalide ne doit pas empêcher la déconnexion.
      toUserMessage(error, "logout");
    }
  }

  revalidatePath("/", "layout");
  redirect("/login");
}
