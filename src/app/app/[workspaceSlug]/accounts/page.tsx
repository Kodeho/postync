import type { Metadata } from "next";
import { connection } from "next/server";

import { Badge } from "@/components/admin/badges";
import { Avatar } from "@/components/ui/avatar";
import { FormAlert } from "@/components/ui/form-alert";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { SocialIcon } from "@/components/ui/social-icon";
import {
  ConnectButton,
  DisconnectButton,
  ReconnectButton,
} from "@/features/accounts/account-forms";
import {
  PublishForm,
  ResumePublicationButton,
  type SelectableMedia,
} from "@/features/accounts/publish-form";
import { getWorkspaceContext } from "@/features/workspaces/context";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/server/admin/audit";
import { getWorkspaceAccess } from "@/server/billing/queries";
import {
  MEDIA_KIND_LABELS,
  PLATFORM_LABELS,
  PUBLICATION_STATUS_LABELS,
  SOCIAL_STATUS_LABELS,
  canPublishMore,
  canResume,
  effectiveStatus,
  needsReconnect,
  type SocialAccountRow,
} from "@/server/social/accounts";
import { listReadyMediaAssets } from "@/server/media/queries";
import {
  checkMediaForPlatform,
  formatBytes,
  formatDuration,
} from "@/server/media/rules";
import { getProvider, isProviderAvailable } from "@/server/social/providers";
import {
  countPublicationsThisMonth,
  listRecentPublications,
  listSocialAccounts,
} from "@/server/social/queries";
import type { SocialPlatform } from "@/types/platform";

export const metadata: Metadata = {
  title: "Comptes sociaux — POSTYNC",
};

const PLATFORMS: { key: SocialPlatform }[] = [
  { key: "instagram" },
  { key: "facebook" },
  { key: "tiktok" },
  { key: "youtube" },
];

/** Codes courts renvoyés par le callback — jamais de texte brut d'URL. */
const CALLBACK_MESSAGES: Record<string, { tone: "notice" | "error"; text: string }> = {
  connected: { tone: "notice", text: "Compte connecté." },
  invalid_state: {
    tone: "error",
    text: "La demande de connexion a expiré ou a déjà été utilisée. Réessayez.",
  },
  not_authorized: {
    tone: "error",
    text: "Cette connexion ne peut pas être finalisée avec votre session actuelle.",
  },
  provider_denied: {
    tone: "error",
    text: "La connexion a été refusée ou annulée sur la plateforme.",
  },
  quota_exceeded: {
    tone: "error",
    text: "Limite de comptes sociaux du plan atteinte.",
  },
  no_social_profile: {
    tone: "error",
    text: "Ce compte ne possède pas encore de profil publiable sur cette plateforme (par exemple : aucune chaîne YouTube sur ce compte Google). Créez-le sur la plateforme, puis réessayez.",
  },
  exchange_failed: {
    tone: "error",
    text: "La plateforme n'a pas finalisé la connexion. Réessayez.",
  },
  // Sélection de Pages (Facebook) : le brouillon a une durée de vie courte.
  draft_not_found: {
    tone: "error",
    text: "La sélection de Pages a expiré ou a déjà été utilisée. Relancez la connexion.",
  },
  provider_unavailable: {
    tone: "error",
    text: "Cette plateforme n'est pas disponible actuellement.",
  },
  listing_failed: {
    tone: "error",
    text: "Impossible de récupérer vos Pages auprès de la plateforme. Réessayez.",
  },
};

function isPlatform(value: string): value is SocialPlatform {
  return PLATFORMS.some((platform) => platform.key === value);
}

function statusTone(status: string): "success" | "warning" | "danger" {
  if (status === "active") return "success";
  if (status === "expired") return "warning";
  return "danger";
}

export default async function AccountsPage({
  params,
  searchParams,
}: PageProps<"/app/[workspaceSlug]/accounts">) {
  await connection();

  const { workspaceSlug } = await params;
  const query = await searchParams;
  const ctx = await getWorkspaceContext(workspaceSlug);
  const workspace = ctx.active.workspace;
  const canManage = ctx.active.role === "owner" || ctx.active.role === "admin";

  const supabase = await createClient();
  const [accounts, { access }, publications, publicationsUsed, mediaAssets] = await Promise.all([
    listSocialAccounts(supabase, workspace.id),
    getWorkspaceAccess(supabase, workspace.id),
    listRecentPublications(supabase, workspace.id),
    countPublicationsThisMonth(supabase, workspace.id),
    listReadyMediaAssets(supabase, workspace.id),
  ]);

  /**
   * Médias proposés pour UNE plateforme, avec la raison quand ils ne
   * conviennent pas. La compatibilité est calculée côté serveur : le
   * navigateur ne reçoit qu'un verdict et une explication.
   */
  const mediaFor = (platform: SocialPlatform): SelectableMedia[] =>
    mediaAssets.map((asset) => {
      const kind = asset.kind === "image" ? "image" : "reel";
      const violations = checkMediaForPlatform(
        asset,
        platform,
        kind,
        PLATFORM_LABELS[platform],
      );
      const details = [
        formatBytes(Number(asset.byte_size)),
        asset.width && asset.height ? `${asset.width} × ${asset.height}` : null,
        asset.duration_seconds !== null
          ? formatDuration(Number(asset.duration_seconds))
          : null,
      ].filter(Boolean);
      return {
        id: asset.id,
        label: `${asset.original_filename} (${details.join(", ")})`,
        compatible: violations.length === 0,
        reasons: violations.map((v) => v.message),
      };
    });
  const publishQuota = access.quotas.publicationsPerMonth;
  const quotaLeft = canPublishMore(publicationsUsed, publishQuota);

  const flashKey =
    typeof query.connected === "string" ? "connected" : typeof query.error === "string" ? query.error : null;
  let flash = flashKey ? CALLBACK_MESSAGES[flashKey] : undefined;

  // Déconnexion d'une plateforme qui n'expose aucune révocation côté app : le
  // texte appartient au provider, la page ne fait que l'afficher.
  if (!flash && query.notice === "manual_revoke" && typeof query.platform === "string") {
    const notice = isPlatform(query.platform) ? getProvider(query.platform)?.revokeNotice : undefined;
    if (notice) {
      flash = { tone: "notice", text: `Compte déconnecté de POSTYNC. ${notice}` };
    }
  }

  const byPlatform = new Map<SocialPlatform, SocialAccountRow[]>();
  for (const account of accounts) {
    const list = byPlatform.get(account.platform) ?? [];
    list.push(account);
    byPlatform.set(account.platform, list);
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Comptes sociaux"
        description={`Connectez les réseaux sur lesquels ce workspace publie. ${accounts.length}/${access.quotas.socialAccounts} compte(s) utilisé(s) (plan ${access.source === "full_access" ? "Full Access" : access.plan.name}).`}
      />

      {flash ? <FormAlert tone={flash.tone}>{flash.text}</FormAlert> : null}

      <ul className="grid gap-4 lg:grid-cols-2" aria-label="Plateformes">
        {PLATFORMS.map(({ key }) => {
          const list = byPlatform.get(key) ?? [];
          const available = isProviderAvailable(key);
          const publisher = getProvider(key)?.publisher ?? null;
          return (
            <li key={key}>
              <Panel className="flex h-full flex-col gap-4 p-5">
                <div className="flex items-center gap-4">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-muted text-foreground"
                  >
                    <SocialIcon platform={key} className="h-6 w-6" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{PLATFORM_LABELS[key]}</p>
                    <p className="text-xs text-muted">
                      {list.length === 0
                        ? "Aucun compte connecté"
                        : `${list.length} compte${list.length > 1 ? "s" : ""} connecté${list.length > 1 ? "s" : ""}`}
                    </p>
                  </div>
                  {canManage ? (
                    <ConnectButton
                      workspaceSlug={workspace.slug}
                      platform={key}
                      label={list.length > 0 ? "Ajouter" : "Connecter"}
                      available={available}
                    />
                  ) : null}
                </div>

                {list.length > 0 ? (
                  <ul className="flex flex-col divide-y divide-border border-t border-border">
                    {list.map((account) => {
                      const status = effectiveStatus(account);
                      // La publication n'est proposée que si TOUT est réuni :
                      // provider capable, compte actif, scopes réellement
                      // accordés et quota du plan disponible.
                      const publishDisabledReason = !publisher
                        ? null
                        : status !== "active"
                          ? "Reconnectez ce compte pour pouvoir publier."
                          : !publisher.requiredScopes.every((scope) =>
                                (account.scopes ?? []).includes(scope),
                              )
                            ? "Ce compte a été connecté avant l'activation de la publication. Reconnectez-le."
                            : !quotaLeft
                              ? `Limite de ${publishQuota} publication(s) par mois atteinte pour ce plan.`
                              : null;
                      return (
                        <li key={account.id} className="flex flex-col gap-3 py-3">
                          <div className="flex items-center gap-3">
                          <Avatar
                            label={account.display_name ?? account.provider_account_id}
                            seed={account.id}
                            src={account.avatar_url}
                            size="sm"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-foreground">
                              {account.display_name ?? account.provider_account_id}
                            </p>
                            <p className="text-xs text-muted">
                              Connecté le {formatDate(account.connected_at)}
                              {status === "active" && account.token_expires_at
                                ? ` · jeton valide jusqu'au ${formatDate(account.token_expires_at)}`
                                : ""}
                            </p>
                          </div>
                          <Badge tone={statusTone(status)}>{SOCIAL_STATUS_LABELS[status]}</Badge>
                          {canManage ? (
                            <div className="flex items-center gap-2">
                              {needsReconnect(status) ? (
                                <ReconnectButton
                                  workspaceSlug={workspace.slug}
                                  platform={key}
                                  accountId={account.id}
                                />
                              ) : null}
                              <DisconnectButton
                                workspaceSlug={workspace.slug}
                                accountId={account.id}
                              />
                            </div>
                          ) : null}
                          </div>
                          {canManage && publisher ? (
                            <PublishForm
                              workspaceSlug={workspace.slug}
                              platform={key}
                              accountId={account.id}
                              accountLabel={account.display_name ?? PLATFORM_LABELS[key]}
                              disabledReason={publishDisabledReason}
                              media={mediaFor(key)}
                              timeZone={workspace.time_zone}
                            />
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </Panel>
            </li>
          );
        })}
      </ul>

      {publications.length > 0 ? (
        <Panel className="flex flex-col gap-4 p-5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Publications récentes</h2>
            <p className="text-xs text-muted">
              {publicationsUsed}/{publishQuota} publication(s) ce mois-ci.
            </p>
          </div>
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {publications.map((publication) => (
              <li key={publication.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {PLATFORM_LABELS[publication.platform]} ·{" "}
                    {MEDIA_KIND_LABELS[publication.media_kind]}
                    {publication.caption ? ` — ${publication.caption}` : ""}
                  </p>
                  <p className="text-xs text-muted">
                    {formatDate(publication.created_at)}
                    {publication.permalink ? (
                      <>
                        {" · "}
                        <a
                          href={publication.permalink}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline underline-offset-2"
                        >
                          Voir
                        </a>
                      </>
                    ) : null}
                  </p>
                </div>
                <Badge
                  tone={
                    publication.status === "published"
                      ? "success"
                      : publication.status === "pending"
                        ? "warning"
                        : "danger"
                  }
                >
                  {PUBLICATION_STATUS_LABELS[publication.status]}
                </Badge>
                {canManage && canResume(publication) ? (
                  <ResumePublicationButton
                    workspaceSlug={workspace.slug}
                    publicationId={publication.id}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {!canManage ? (
        <p className="text-sm text-muted">
          Seul le propriétaire ou un admin du workspace peut connecter ou déconnecter des comptes.
        </p>
      ) : null}
    </div>
  );
}
