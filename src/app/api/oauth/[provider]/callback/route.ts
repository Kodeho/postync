import { NextResponse } from "next/server";

import { getSiteOrigin } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceAccess } from "@/server/billing/queries";
import { handleOAuthCallback } from "@/server/social/callback";
import { getProvider } from "@/server/social/providers";
import { createServiceClient } from "@/server/supabase/service-client";
import type { SocialPlatform } from "@/types/platform";

/**
 * Callback OAuth — `GET /api/oauth/[provider]/callback`.
 *
 * Route fine : résout le provider, délègue tout le travail (state, session,
 * rôle, quota, Vault, upsert) à `handleOAuthCallback`, puis redirige vers la
 * page des comptes avec un simple code (`?connected=` / `?error=`) — jamais
 * de token ni de détail sensible dans l'URL.
 */

const PLATFORMS: readonly SocialPlatform[] = ["instagram", "facebook", "tiktok", "youtube"];

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/oauth/[provider]/callback">,
) {
  const { provider: providerParam } = await ctx.params;
  const origin = await getSiteOrigin();

  if (!(PLATFORMS as readonly string[]).includes(providerParam)) {
    return NextResponse.redirect(new URL("/app", origin), 302);
  }
  const provider = getProvider(providerParam as SocialPlatform);
  if (!provider) {
    return NextResponse.redirect(new URL("/app", origin), 302);
  }

  const url = new URL(request.url);
  const result = await handleOAuthCallback(
    {
      provider,
      userClient: await createClient(),
      serviceClient: createServiceClient(),
      redirectUri: `${origin}/api/oauth/${provider.platform}/callback`,
      getQuota: async (workspaceId) => {
        const { access } = await getWorkspaceAccess(createServiceClient(), workspaceId);
        return access.quotas.socialAccounts;
      },
    },
    url.searchParams,
  );

  // Plateforme à actifs multiples : rien n'est connecté, l'utilisateur doit
  // encore choisir ses Pages. On l'envoie sur l'écran de sélection, qui ne
  // reçoit qu'un identifiant de brouillon — aucun jeton dans l'URL.
  if (result.outcome === "select_assets" && result.slug && result.draftId) {
    const selection = new URL(`/app/${result.slug}/accounts/select`, origin);
    selection.searchParams.set("draft", result.draftId);
    return NextResponse.redirect(selection, 302);
  }

  const destination = result.slug
    ? `/app/${result.slug}/accounts`
    : "/app";
  const target = new URL(destination, origin);
  if (result.outcome === "connected") {
    target.searchParams.set("connected", provider.platform);
  } else {
    target.searchParams.set("error", result.outcome);
  }
  return NextResponse.redirect(target, 302);
}
