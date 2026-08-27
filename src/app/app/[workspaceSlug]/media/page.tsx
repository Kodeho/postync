import type { Metadata } from "next";
import { connection } from "next/server";
import { Images } from "lucide-react";

import { Badge } from "@/components/admin/badges";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { CompatibilityList, DeleteMediaButton } from "@/features/media/media-list";
import { MediaUploadForm } from "@/features/media/upload-form";
import { getWorkspaceContext } from "@/features/workspaces/context";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/server/admin/audit";
import { getWorkspaceAccess } from "@/server/billing/queries";
import { listMediaAssets } from "@/server/media/queries";
import {
  compatibilityReport,
  describeRatio,
  formatBytes,
  formatDuration,
} from "@/server/media/rules";
import { PLATFORM_LABELS } from "@/server/social/accounts";
import { getProvider } from "@/server/social/providers";
import type { SocialPlatform } from "@/types/platform";

export const metadata: Metadata = {
  title: "Médiathèque — POSTYNC",
};

const PLATFORMS: readonly SocialPlatform[] = ["instagram", "facebook", "youtube", "tiktok"];

const STATUS_LABELS: Record<string, { label: string; tone: "success" | "warning" | "danger" }> = {
  ready: { label: "Prêt", tone: "success" },
  uploading: { label: "En cours d'envoi", tone: "warning" },
  invalid: { label: "Refusé", tone: "danger" },
};

export default async function MediaPage({ params }: PageProps<"/app/[workspaceSlug]/media">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  const workspace = ctx.active.workspace;
  const canManage = ctx.active.role === "owner" || ctx.active.role === "admin";

  const supabase = await createClient();
  const [assets, { access }] = await Promise.all([
    listMediaAssets(supabase, workspace.id),
    getWorkspaceAccess(supabase, workspace.id),
  ]);

  const usedBytes = assets
    .filter((asset) => asset.status !== "invalid")
    .reduce((total, asset) => total + Number(asset.byte_size), 0);
  const quotaBytes = access.quotas.storageGb * 1024 * 1024 * 1024;

  // Un réseau n'est proposé que si POSTYNC sait réellement y publier.
  const platforms = PLATFORMS.map((platform) => ({
    platform,
    label: PLATFORM_LABELS[platform],
    publishingAvailable: Boolean(getProvider(platform)?.publisher),
  }));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Médiathèque"
        description={`Importez un média une seule fois, puis publiez-le sur vos réseaux. ${formatBytes(usedBytes)} sur ${formatBytes(quotaBytes)} utilisés.`}
      />

      {canManage ? (
        <Panel className="p-5">
          <MediaUploadForm workspaceSlug={workspace.slug} />
        </Panel>
      ) : null}

      {assets.length === 0 ? (
        <EmptyState
          icon={<Images className="h-5 w-5" />}
          title="Vos photos et vidéos apparaîtront ici."
          description="Importez un média une seule fois, puis publiez-le sur tous vos réseaux."
        />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2" aria-label="Médias">
          {assets.map((asset) => {
            const statut = STATUS_LABELS[asset.status] ?? STATUS_LABELS.invalid;
            const rapport = compatibilityReport(asset, platforms);
            return (
              <li key={asset.id}>
                <Panel className="flex h-full flex-col gap-4 p-5">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {asset.original_filename}
                      </p>
                      <p className="text-xs text-muted">
                        {asset.kind === "video" ? "Vidéo" : "Image"} · {formatBytes(Number(asset.byte_size))}
                        {asset.width && asset.height
                          ? ` · ${asset.width} × ${asset.height} (${describeRatio(asset.width / asset.height)})`
                          : ""}
                        {asset.duration_seconds !== null
                          ? ` · ${formatDuration(Number(asset.duration_seconds))}`
                          : ""}
                        {asset.video_codec ? ` · ${asset.video_codec}` : ""}
                      </p>
                      <p className="text-xs text-muted">Importé le {formatDate(asset.created_at)}</p>
                    </div>
                    <Badge tone={statut.tone}>{statut.label}</Badge>
                  </div>

                  {asset.status === "invalid" && asset.status_detail ? (
                    <p className="text-xs text-danger">{asset.status_detail}</p>
                  ) : null}

                  {asset.status === "ready" ? <CompatibilityList report={rapport} /> : null}

                  {canManage ? (
                    <div className="mt-auto flex justify-end">
                      <DeleteMediaButton
                        workspaceSlug={workspace.slug}
                        assetId={asset.id}
                        filename={asset.original_filename}
                      />
                    </div>
                  ) : null}
                </Panel>
              </li>
            );
          })}
        </ul>
      )}

      {!canManage ? (
        <p className="text-sm text-muted">
          Seul le propriétaire ou un admin du workspace peut importer ou supprimer des médias.
        </p>
      ) : null}
    </div>
  );
}
