import type { Metadata } from "next";
import { connection } from "next/server";

import { Badge } from "@/components/admin/badges";
import { Avatar } from "@/components/ui/avatar";
import { FormAlert } from "@/components/ui/form-alert";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import {
  ConnectButton,
  DisconnectButton,
  ReconnectButton,
} from "@/features/accounts/account-forms";
import { getWorkspaceContext } from "@/features/workspaces/context";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/server/admin/audit";
import { getWorkspaceAccess } from "@/server/billing/queries";
import {
  PLATFORM_LABELS,
  SOCIAL_STATUS_LABELS,
  effectiveStatus,
  needsReconnect,
  type SocialAccountRow,
} from "@/server/social/accounts";
import { isProviderAvailable } from "@/server/social/providers/types";
import { listSocialAccounts } from "@/server/social/queries";
import type { SocialPlatform } from "@/types/platform";

export const metadata: Metadata = {
  title: "Comptes sociaux — POSTYNC",
};

const PLATFORMS: { key: SocialPlatform; abbr: string }[] = [
  { key: "instagram", abbr: "Ig" },
  { key: "facebook", abbr: "Fb" },
  { key: "tiktok", abbr: "Tt" },
  { key: "youtube", abbr: "Yt" },
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
  exchange_failed: {
    tone: "error",
    text: "La plateforme n'a pas finalisé la connexion. Réessayez.",
  },
};

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
  const [accounts, { access }] = await Promise.all([
    listSocialAccounts(supabase, workspace.id),
    getWorkspaceAccess(supabase, workspace.id),
  ]);

  const flashKey =
    typeof query.connected === "string" ? "connected" : typeof query.error === "string" ? query.error : null;
  const flash = flashKey ? CALLBACK_MESSAGES[flashKey] : undefined;

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
        {PLATFORMS.map(({ key, abbr }) => {
          const list = byPlatform.get(key) ?? [];
          const available = isProviderAvailable(key);
          return (
            <li key={key}>
              <Panel className="flex h-full flex-col gap-4 p-5">
                <div className="flex items-center gap-4">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-muted text-sm font-semibold text-muted"
                  >
                    {abbr}
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
                      return (
                        <li key={account.id} className="flex items-center gap-3 py-3">
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

      {!canManage ? (
        <p className="text-sm text-muted">
          Seul le propriétaire ou un admin du workspace peut connecter ou déconnecter des comptes.
        </p>
      ) : null}
    </div>
  );
}
