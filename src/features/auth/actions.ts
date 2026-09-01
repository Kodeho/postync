"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { sendPasswordChangedEmail } from "@/server/email/notifications";
import { recordLegalAcceptance } from "@/server/legal/acceptance";
import { createServiceClient } from "@/server/supabase/service-client";
import { isSupabaseConfigured, requireSupabaseEnv } from "@/lib/supabase/env";
import { safeReturnPath } from "@/lib/return-path";
import { getSiteOrigin } from "@/lib/site-url";

import { toUserMessage } from "./errors";
import { shouldDiscloseResetError } from "./reset-disclosure";
import type { AuthFormState, SignupPreservedValues } from "./state";
import {
  extractSignupPreservedValues,
  validateEmailOnly,
  validateLogin,
  validateNewPassword,
  validatePasswordChange,
  validateSignup,
} from "./validation";

const NOT_CONFIGURED_STATE: AuthFormState = {
  error:
    "L'authentification n'est pas encore configurée sur cette installation.",
  notice: null,
};

function failure(error: string): AuthFormState {
  return { error, notice: null };
}

/**
 * Échec d'inscription : renvoie le message d'erreur ET les champs non
 * sensibles (nom, e-mail) pour que le formulaire puisse les réafficher.
 *
 * Le mot de passe et sa confirmation ne figurent jamais dans `values` :
 * ils ne sont ni conservés côté serveur, ni renvoyés au navigateur.
 */
function signupFailure(
  error: string,
  values: SignupPreservedValues,
): AuthFormState {
  return { error, notice: null, values };
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

  const preserved = extractSignupPreservedValues(formData);

  const parsed = validateSignup(formData);
  if (!parsed.ok) {
    return signupFailure(parsed.error, preserved);
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
      return signupFailure(toUserMessage(error, "signup"), preserved);
    }

    // Lorsque la confirmation d'e-mail est active, Supabase renvoie un
    // utilisateur factice sans identité pour une adresse déjà inscrite.
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
      return signupFailure("Cette adresse e-mail est déjà utilisée.", preserved);
    }

    // TRACE DE L'ACCEPTATION, écrite APRÈS la création et seulement si elle a
    // réussi. L'ordre compte : enregistrer avant produirait une preuve
    // d'acceptation pour un compte qui n'existe pas, et la contrainte de clé
    // étrangère la refuserait de toute façon.
    //
    // Elle est écrite ici plutôt qu'à la première connexion parce que c'est
    // ICI que l'utilisateur a coché la case et lu les liens. Attendre
    // reviendrait à dater le consentement d'un moment où il n'a rien accepté.
    if (data.user) {
      const trace = await recordLegalAcceptance(data.user.id);
      if (!trace.ok) {
        // Le compte EXISTE désormais : échouer ici laisserait l'utilisateur
        // sans compte utilisable et sans message utile. La garde de
        // réacceptation le rattrapera à sa première visite — c'est
        // précisément ce pour quoi elle existe.
        console.error(`[auth:signup] acceptation non enregistrée: ${trace.code}`);
      }
    }

    hasSession = data.session !== null;
  } catch (error) {
    return signupFailure(toUserMessage(error, "signup"), preserved);
  }

  if (!hasSession) {
    return {
      error: null,
      notice:
        "Compte créé. Un e-mail de confirmation vous a été envoyé : cliquez sur le lien qu'il contient pour activer votre compte.",
    };
  }

  revalidatePath("/", "layout");
  // Destination de retour, si elle a survecu au formulaire : quelqu'un qui
  // arrive par une invitation doit y revenir, pas atterrir sur l'accueil.
  // `safeReturnPath` n'accepte qu'un chemin interne — sans quoi ce serait une
  // redirection ouverte, juste apres la saisie d'un mot de passe.
  redirect(safeReturnPath(String(formData.get("next") ?? "")));
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
  redirect(safeReturnPath(String(formData.get("next") ?? "")));
}



/**
 * Prévient qu'un mot de passe vient de changer.
 *
 * CE MESSAGE N'EST PAS POUR CELUI QUI A AGI — il le sait. Il est pour celui
 * qui n'a rien fait : c'est souvent le seul signal qu'une personne reçoit
 * lorsqu'un tiers a pris la main sur son compte.
 *
 * L'ENVOI NE PEUT PAS FAIRE ÉCHOUER LE CHANGEMENT. Le mot de passe est déjà
 * modifié quand on arrive ici ; rendre une erreur ferait croire le contraire,
 * et l'utilisateur retenterait avec un ancien mot de passe qui ne vaut plus
 * rien. Un échec est donc journalisé et rien de plus.
 */
async function prevenirDuChangement(
  userId: string,
  email: string | null | undefined,
  origin: "reset" | "settings",
): Promise<void> {
  if (!email) return;
  try {
    await sendPasswordChangedEmail(createServiceClient(), {
      userId,
      email,
      origin,
      // Le fuseau du compte n'est pas connu ici : un utilisateur peut
      // appartenir à plusieurs workspaces, aux fuseaux différents. On date
      // donc en heure de Paris, cohérent avec le siège de l'éditeur, plutôt
      // que d'en choisir un au hasard parmi les siens.
      timeZone: "Europe/Paris",
    });
  } catch (error) {
    toUserMessage(error, "password-changed-notice");
  }
}

// ---------------------------------------------------------------------------
// Réinitialisation de mot de passe (C15)
// ---------------------------------------------------------------------------

/**
 * Réponse unique de la demande de réinitialisation.
 *
 * LE MÊME MESSAGE DANS TOUS LES CAS, y compris lorsque l'adresse n'existe
 * pas. Ce formulaire est public : répondre « compte inconnu » le
 * transformerait en oracle permettant de savoir, adresse par adresse, qui est
 * client de POSTYNC. La formulation est donc volontairement au conditionnel —
 * elle ne promet pas qu'un e-mail est parti.
 */
const RESET_REQUESTED_NOTICE =
  "Si un compte existe pour cette adresse, un lien de réinitialisation vient d'être envoyé. Ouvrez-le depuis CE navigateur, sinon le lien sera refusé.";

/**
 * Demande un lien de réinitialisation.
 *
 * SUR LE NAVIGATEUR. Supabase émet un lien PKCE dont le vérificateur est
 * déposé dans un cookie du navigateur qui a fait la demande. Ouvrir le lien
 * ailleurs — un webmail sur le téléphone, un autre profil — échoue avec
 * `flow_state_expired`, sans que rien ne soit cassé. Le message le dit
 * d'avance, plutôt que de laisser l'utilisateur en tirer la conclusion qu'il
 * n'a pas de compte.
 */
export async function requestPasswordResetAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!isSupabaseConfigured()) {
    return NOT_CONFIGURED_STATE;
  }

  const parsed = validateEmailOnly(formData);
  if (!parsed.ok) {
    return failure(parsed.error);
  }

  try {
    const supabase = await createClient();
    const origin = await getSiteOrigin();

    const { error } = await supabase.auth.resetPasswordForEmail(parsed.value, {
      // Le lien ouvre une session, puis atterrit sur le formulaire de
      // changement. Sans ce `next`, il déposerait la personne dans
      // l'application sans jamais lui faire choisir un nouveau mot de passe —
      // un lien de connexion déguisé en lien de réinitialisation.
      redirectTo: `${origin}/auth/callback?next=/reset-password`,
    });

    if (error) {
      // `toUserMessage` journalise dans tous les cas ; seule la limite de
      // débit est RENVOYÉE. Voir `reset-disclosure.ts` pour le pourquoi.
      const message = toUserMessage(error, "reset-request");
      if (shouldDiscloseResetError("code" in error ? error.code : null)) {
        return failure(message);
      }
    }
  } catch (error) {
    toUserMessage(error, "reset-request");
  }

  return { error: null, notice: RESET_REQUESTED_NOTICE };
}

/**
 * Enregistre le nouveau mot de passe.
 *
 * N'est atteignable qu'avec la session ouverte par le lien de
 * réinitialisation : `updateUser` échoue sans session, et la page qui porte ce
 * formulaire refuse déjà de s'afficher sans elle.
 *
 * LES AUTRES SESSIONS SONT REVOQUEES. Quelqu'un qui réinitialise son mot de
 * passe le fait souvent parce qu'il soupçonne un accès indésirable ; laisser
 * vivre les sessions déjà ouvertes annulerait tout le bénéfice de
 * l'opération.
 */
export async function updatePasswordAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!isSupabaseConfigured()) {
    return NOT_CONFIGURED_STATE;
  }

  const parsed = validateNewPassword(formData);
  if (!parsed.ok) {
    return failure(parsed.error);
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return failure(
        "Votre lien de réinitialisation a expiré. Demandez-en un nouveau.",
      );
    }

    const { error } = await supabase.auth.updateUser({ password: parsed.value.password });
    if (error) {
      return failure(toUserMessage(error, "reset-update"));
    }

    // Révocation des autres sessions. Un échec ici ne doit pas faire croire
    // que le changement a échoué : le mot de passe, lui, est bien changé.
    const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });
    if (signOutError) {
      toUserMessage(signOutError, "reset-signout-others");
    }

    await prevenirDuChangement(user.id, user.email, "reset");
  } catch (error) {
    return failure(toUserMessage(error, "reset-update"));
  }

  revalidatePath("/", "layout");
  redirect("/app");
}


/**
 * Changement de mot de passe par quelqu'un déjà connecté (C15).
 *
 * POURQUOI EXIGER LE MOT DE PASSE ACTUEL. `updateUser` ne le demande pas : une
 * session ouverte suffit. Sur un poste partagé, un écran resté déverrouillé
 * permettrait donc de s'approprier définitivement le compte — changer le mot
 * de passe, révoquer les autres sessions, et le propriétaire légitime se
 * retrouverait dehors. La vérification distingue « la personne est devant
 * l'écran » de « quelqu'un a trouvé l'écran ».
 *
 * LA VÉRIFICATION SE FAIT SUR UN CLIENT JETABLE, sans cookies. Utiliser le
 * client de la session réécrirait ses jetons au passage : un mot de passe
 * actuel erroné n'a aucune raison de perturber la session en cours.
 */
export async function changePasswordAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!isSupabaseConfigured()) {
    return NOT_CONFIGURED_STATE;
  }

  const parsed = validatePasswordChange(formData);
  if (!parsed.ok) {
    return failure(parsed.error);
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user?.email) {
      return failure("Votre session a expiré. Reconnectez-vous.");
    }

    const { url, anonKey } = requireSupabaseEnv();
    const verificateur = createSupabaseClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { error: mauvais } = await verificateur.auth.signInWithPassword({
      email: user.email,
      password: parsed.value.currentPassword,
    });
    if (mauvais) {
      // Message volontairement identique quelle que soit la raison du refus :
      // c'est le compte de la personne connectée, il n'y a rien à divulguer,
      // mais rien à détailler non plus.
      toUserMessage(mauvais, "password-change-verify");
      return failure("Mot de passe actuel incorrect.");
    }

    const { error } = await supabase.auth.updateUser({ password: parsed.value.password });
    if (error) {
      return failure(toUserMessage(error, "password-change"));
    }

    // Même raisonnement qu'après une réinitialisation : on change souvent de
    // mot de passe parce qu'on soupçonne un accès indésirable.
    const { error: revocation } = await supabase.auth.signOut({ scope: "others" });
    if (revocation) {
      toUserMessage(revocation, "password-change-signout-others");
    }

    await prevenirDuChangement(user.id, user.email, "settings");
  } catch (error) {
    return failure(toUserMessage(error, "password-change"));
  }

  return {
    error: null,
    notice:
      "Mot de passe modifié. Vos autres sessions ont été fermées ; celle-ci reste ouverte.",
  };
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
