import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { GrantFullAccessForm, RevokeFullAccessForm } from "@/components/admin/action-forms";
import {
  AccessModeBadge,
  AccountStatusBadge,
  WorkspaceRoleBadge,
} from "@/components/admin/badges";
import { DataTable, Td, Th } from "@/components/admin/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { formatDate } from "@/server/admin/audit";
import { requirePlatformRole } from "@/server/admin/authorization";
import { can } from "@/server/admin/permissions";
import { getWorkspace, listWorkspaceMembers } from "@/server/admin/queries";

export const metadata: Metadata = {
  title: "Fiche workspace — POSTYNC Admin",
};

const UUID = /^[0-9a-f-]{36}$/i;

export default async function AdminWorkspacePage({
  params,
}: PageProps<"/admin/workspaces/[workspaceId]">) {
  await connection();
  const actor = await requirePlatformRole();

  const { workspaceId } = await params;
  if (!UUID.test(workspaceId)) notFound();

  const ws = await getWorkspace(actor, workspaceId);
  if (!ws) notFound();
  const members = await listWorkspaceMembers(actor, workspaceId);

  const fullAccessActive = ws.access_active;
  const canManageAccess = can(actor.role, "workspaces.full_access");

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm">
        <Link href="/admin/workspaces" className="font-medium text-primary hover:underline">
          ← Workspaces
        </Link>
      </p>

      <PageHeader
        title={ws.name}
        description={`/app/${ws.slug}`}
        actions={<AccessModeBadge mode={ws.access_mode} active={ws.access_active} />}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-6">
          <Panel as="section" aria-labelledby="ws-info" className="p-6">
            <h2 id="ws-info" className="text-base font-semibold text-foreground">
              Workspace
            </h2>
            <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
              <dt className="text-muted">ID</dt>
              <dd className="font-mono text-xs text-foreground">{ws.id}</dd>
              <dt className="text-muted">Slug</dt>
              <dd className="font-mono text-xs text-foreground">{ws.slug}</dd>
              <dt className="text-muted">Propriétaire</dt>
              <dd>
                <Link href={`/admin/users/${ws.owner_id}`} className="text-primary hover:underline">
                  {ws.owner_name ?? ws.owner_email}
                </Link>
                <span className="ml-2 text-xs text-muted">{ws.owner_email}</span>
              </dd>
              <dt className="text-muted">Création</dt>
              <dd className="text-foreground">{formatDate(ws.created_at, true)}</dd>
              <dt className="text-muted">Abonnement</dt>
              <dd className="text-muted">— (Stripe, C7)</dd>
              <dt className="text-muted">Ressources</dt>
              <dd className="text-muted">Comptes sociaux, médias, publications : étapes ultérieures.</dd>
            </dl>
          </Panel>

          <section aria-labelledby="ws-members" className="flex flex-col gap-3">
            <h2 id="ws-members" className="text-base font-semibold text-foreground">
              Membres ({members.length})
            </h2>
            <DataTable
              caption="Membres du workspace"
              empty={members.length === 0 ? "Aucun membre." : undefined}
              head={
                <>
                  <Th>Membre</Th>
                  <Th>Rôle workspace</Th>
                  <Th>Statut du compte</Th>
                  <Th>Depuis</Th>
                </>
              }
            >
              {members.map((m) => (
                <tr key={m.user_id}>
                  <Td>
                    <Link href={`/admin/users/${m.user_id}`} className="block">
                      <span className="block font-medium text-foreground">{m.display_name ?? "—"}</span>
                      <span className="block text-xs text-muted">{m.email}</span>
                    </Link>
                  </Td>
                  <Td>
                    <WorkspaceRoleBadge role={m.role} />
                  </Td>
                  <Td>
                    <AccountStatusBadge status={m.account_status} />
                  </Td>
                  <Td className="text-muted">{formatDate(m.created_at)}</Td>
                </tr>
              ))}
            </DataTable>
          </section>
        </div>

        <aside className="flex flex-col gap-6">
          <Panel as="section" aria-labelledby="ws-entitlement" className="p-6">
            <h2 id="ws-entitlement" className="text-base font-semibold text-foreground">
              Full Access
            </h2>
            <dl className="mt-3 grid gap-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">Mode</dt>
                <dd>
                  <AccessModeBadge mode={ws.access_mode} active={ws.access_active} />
                </dd>
              </div>
              {ws.access_mode === "full_access" ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted">Depuis</dt>
                    <dd className="text-foreground">{formatDate(ws.starts_at)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted">Jusqu&apos;au</dt>
                    <dd className="text-foreground">{ws.ends_at ? formatDate(ws.ends_at) : "Sans expiration"}</dd>
                  </div>
                </>
              ) : null}
              {ws.reason ? (
                <div className="flex flex-col gap-0.5">
                  <dt className="text-muted">Raison</dt>
                  <dd className="text-foreground">{ws.reason}</dd>
                </div>
              ) : null}
              {ws.granted_by_email ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted">Par</dt>
                  <dd className="truncate text-foreground">{ws.granted_by_email}</dd>
                </div>
              ) : null}
            </dl>

            {canManageAccess ? (
              <div className="mt-5 border-t border-border pt-5">
                {fullAccessActive ? (
                  <RevokeFullAccessForm workspaceId={ws.id} />
                ) : (
                  <GrantFullAccessForm workspaceId={ws.id} />
                )}
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted">Lecture seule pour votre rôle ({actor.role}).</p>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}
