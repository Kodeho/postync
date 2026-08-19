import { NextResponse, type NextRequest } from "next/server";

import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

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
 * Valide la destination de redirection.
 *
 * Sans ce filtre, `?next=https://exemple-malveillant.test` transformerait la
 * route de confirmation en redirection ouverte. Seuls les chemins internes
 * simples sont acceptés (`//host` est un chemin protocol-relative, donc rejeté).
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/app";
  }
  return raw;
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
  const next = safeNext(searchParams.get("next"));

  const failureUrl = new URL("/login", origin);
  failureUrl.searchParams.set("error", "confirmation");

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
