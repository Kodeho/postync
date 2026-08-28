import { NextResponse, type NextRequest } from "next/server";

import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { safeReturnPath } from "@/lib/return-path";

/**
 * Types d'OTP e-mail acceptés.
 *
 * Défini localement plutôt qu'importé : `EmailOtpType` n'est pas réexporté par
 * `@supabase/supabase-js` et ne vit que dans la dépendance transitive
 * `@supabase/auth-js`.
 */
const EMAIL_OTP_TYPES = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
] as const;

type EmailOtpType = (typeof EMAIL_OTP_TYPES)[number];

function isEmailOtpType(value: string | null): value is EmailOtpType {
  return value !== null && EMAIL_OTP_TYPES.includes(value as EmailOtpType);
}

/**
 * Callback de confirmation d'adresse e-mail Supabase.
 *
 * Prend en charge les deux formats de lien émis par Supabase :
 * - `?code=...` (flux PKCE) → `exchangeCodeForSession`
 * - `?token_hash=...&type=...` (flux OTP) → `verifyOtp`
 *
 * La confirmation n'est jamais contournée : sans jeton valide, aucune session
 * n'est ouverte et l'utilisateur est renvoyé vers `/login`.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);

  // DESTINATION DE RETOUR. Elle arrive par l'URL, donc depuis un courriel :
  // c'est exactement la situation d'une redirection ouverte. Sans filtre,
  // `?next=https://exemple-malveillant.test` renverrait la personne sur un
  // site tiers juste après l'ouverture de sa session — le moment idéal pour
  // lui présenter une fausse page de connexion.
  //
  // `safeReturnPath` est la MÊME règle que celle appliquée à la connexion et
  // à l'inscription (C14). Cette route avait sa propre version, plus faible :
  // elle laissait passer `/\exemple.com`, que certains navigateurs
  // interprètent comme `//`, ainsi que les caractères de contrôle. Deux
  // logiques pour un même risque, c'est une de trop — et c'est toujours la
  // plus faible qui décide.
  const next = safeReturnPath(searchParams.get("next"));

  // Le message d'echec depend de ce qui a ete tente : « votre inscription n'a
  // pas pu etre confirmee » n'a aucun sens pour quelqu'un qui reinitialise son
  // mot de passe, et le laisse sans la seule action utile.
  const estRecuperation =
    searchParams.get("type") === "recovery" ||
    (searchParams.get("next") ?? "").startsWith("/reset-password");

  const failureUrl = new URL("/login", origin);
  failureUrl.searchParams.set("error", estRecuperation ? "recovery" : "confirmation");

  if (!isSupabaseConfigured()) {
    return NextResponse.redirect(failureUrl);
  }

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
    console.error(`[auth:callback] exchangeCodeForSession: ${error.code ?? error.name}`);
    return NextResponse.redirect(failureUrl);
  }

  if (tokenHash && isEmailOtpType(type)) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
    console.error(`[auth:callback] verifyOtp: ${error.code ?? error.name}`);
    return NextResponse.redirect(failureUrl);
  }

  return NextResponse.redirect(failureUrl);
}
