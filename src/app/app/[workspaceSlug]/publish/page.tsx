import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import {
  BroadcastForm,
  type BroadcastAccount,
  type BroadcastMedia,
} from "@/features/publish/broadcast-form";
import { getWorkspaceContext } from "@/features/workspaces/context";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceAccess } from "@/server/billing/queries";
import { listReadyMediaAssets } from "@/server/media/queries";
import { checkMediaForPlatform, formatBytes, formatDuration } from "@/server/media/rules";
import { PLATFORM_LABELS, effectiveStatus } from "@/server/social/accounts";
import { getProvider } from "@/server/social/providers";
import { countPublicationsThisMonth, listSocialAccounts } from "@/server/social/queries";
import type { SocialPlatform } from "@/types/platform";

export const metadata: Metadata = {
  title: "Nouvelle publication — POSTYNC",
};

/**
 * Publication multi-réseaux (C11).
 *
 * C'est la promesse du produit : importer une fois, publier partout. Jusqu'ici
 * il fallait passer par la page Comptes sociaux et répéter l'opération réseau
 * par réseau.
 *
 * TOUTE LA COMPATIBILITÉ EST CALCULÉE ICI, côté serveur, et le navigateur ne
 * reçoit qu'un verdict et une explication — jamais les règles elles-mêmes.
 * Elles diffèrent nettement d'un réseau à l'autre (un Reel Facebook impose le
 * 9:16 et 90 secondes là où Instagram accepte presque tout ratio jusqu'à
 * 15 minutes), et les dupliquer côté client garantirait qu'elles divergent.
 */
export default async function PublishPage({
  params,
}: PageProps<"/app/[workspaceSlug]/publish">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  const workspace = ctx.active.workspace;
  const canPublish = ctx.active.role === "owner" || ctx.active.role === "admin";

  const supabase = await createClient();
  const [comptes, mediaAssets, { access }, utilisees] = await Promise.all([
    listSocialAccounts(supabase, workspace.id),
    listReadyMediaAssets(supabase, workspace.id),
    getWorkspaceAccess(supabase, workspace.id),
    countPublicationsThisMonth(supabase, workspace.id),
  ]);

  const restantes = Math.max(0, access.quotas.publicationsPerMonth - utilisees);

  const accounts: BroadcastAccount[] = comptes.map((compte) => {
    const statut = effectiveStatus(compte);
    const publisher = getProvider(compte.platform)?.publisher ?? null;
    return {
      id: compte.id,
      platform: compte.platform,
      platformLabel: PLATFORM_LABELS[compte.platform],
      label: compte.display_name ?? compte.provider_account_id,
      available: statut === "active" && publisher !== null,
      unavailableReason:
        statut !== "active"
          ? "Ce compte doit être reconnecté."
          : publisher === null
            ? "La publication n'est pas encore disponible pour ce réseau."
            : null,
    };
  });

  // Plateformes réellement présentes : inutile d'évaluer un réseau absent.
  const plateformes = [...new Set(comptes.map((c) => c.platform))] as SocialPlatform[];

  const media: BroadcastMedia[] = mediaAssets.map((asset) => {
    const kind = asset.kind === "image" ? ("image" as const) : ("reel" as const);
    const compatibleWith: BroadcastMedia["compatibleWith"] = {};
    for (const plateforme of plateformes) {
      const violations = checkMediaForPlatform(
        asset,
        plateforme,
        kind,
        PLATFORM_LABELS[plateforme],
      );
      compatibleWith[plateforme] = {
        ok: violations.length === 0,
        reasons: violations.map((v) => v.message),
      };
    }
    const duree =
      asset.duration_seconds !== null ? `, ${formatDuration(Number(asset.duration_seconds))}` : "";
    const dimensions = asset.width && asset.height ? `, ${asset.width} × ${asset.height}` : "";
    return {
      id: asset.id,
      label: `${asset.original_filename} (${formatBytes(Number(asset.byte_size))}${dimensions}${duree})`,
      kind,
      compatibleWith,
    };
  });

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Nouvelle publication"
        description="Choisissez un média, puis les réseaux sur lesquels le publier — en une seule fois."
      />

      <Panel as="section" aria-label="Publication multi-réseaux" className="p-6">
        {canPublish ? (
          <BroadcastForm
            workspaceSlug={workspace.slug}
            accounts={accounts}
            media={media}
            remainingThisMonth={restantes}
            timeZone={workspace.time_zone}
          />
        ) : (
          <p className="text-sm text-muted">
            Seul le propriétaire ou un admin du workspace peut publier.
          </p>
        )}
      </Panel>

      <p className="text-xs text-muted">
        Les médias viennent de la{" "}
        <Link
          href={`/app/${workspace.slug}/media`}
          className="text-primary underline-offset-4 hover:underline"
        >
          Médiathèque
        </Link>
        . Les publications programmées apparaissent dans le{" "}
        <Link
          href={`/app/${workspace.slug}/calendar`}
          className="text-primary underline-offset-4 hover:underline"
        >
          Calendrier
        </Link>
        .
      </p>
    </div>
  );
}
