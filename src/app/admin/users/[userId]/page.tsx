import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { SetRoleForm, SuspendUserForm } from "@/components/admin/action-forms";
import {
  AccessModeBadge,
  AccountStatusBadge,
  PlatformRoleBadge,
  WorkspaceRoleBadge,
} from "@/components/admin/badges";
import { DataTable, Td, Th } from "@/components/admin/data-table";
import { Avatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { formatDate } from "@/server/admin/audit";
import { requirePlatformRole } from "@/server/admin/authorization";
import {
  assignableRoles,
  can,
  decideStatusChange,
  isPlatformRole,
} from "@/server/admin/permissions";
import { getUser, listUserWorkspaces } from "@/server/admin/queries";

export const metadata: Metadata = {
  title: "Fiche utilisateur — POSTYNC Admin",
};

const UUID = /^[0-9a-f-]{36}$/i;

export default async function AdminUserPage({ params }: PageProps<"/admin/users/[userId]">) {
  await connection();
  const actor = await requirePlatformRole();

  const { userId } = await params;
  if (!UUID.test(userId)) notFound();

  const user = await getUser(actor, userId);
  if (!user || !isPlatformRole(user.platform_role)) notFound();

  const workspaces = await listUserWorkspaces(actor, userId);
  const isSelf = user.id === actor.user.id;

  const statusDecision = decideStatusChange({
    actorRole: actor.role,
    targetRole: user.platform_role,
    isSelf,
  });
  const roleOptions = can(actor.role, "users.change_role")
    ? assignableRoles({ actorRole: actor.role, targetRole: user.platform_role, isSelf })
    : [];
  const canAct = can(actor.role, "users.suspend") || can(actor.role, "users.change_role");

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm">
        <Link href="/admin/users" className="font-medium text-primary hover:underline">
          ← Utilisateurs
        </Link>
      </p>

      <PageHeader
        title={user.display_name ?? user.email}
        description={user.email}
        actions={
          <div className="flex items-center gap-2">
            <AccountStatusBadge status={user.account_status} />
            <PlatformRoleBadge role={user.platform_role} />
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-6">
          <Panel as="section" aria-labelledby="user-profile" className="p-6">
            <div className="flex items-center gap-4">
              <Avatar label={user.display_name ?? user.email} seed={user.id} src={user.avatar_url} size="lg" />
              <div>
                <h2 id="user-profile" className="text-base font-semibold text-foreground">
                  Profil
                </h2>
                <p className="text-sm text-muted">{user.display_name ?? "Sans nom affiché"}</p>
              </div>
            </div>
            <dl className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
              <dt className="text-muted">ID</dt>
              <dd className="font-mono text-xs text-foreground">{user.id}</dd>
              <dt className="text-muted">E-mail</dt>
              <dd className="text-foreground">{user.email}</dd>
              <dt className="text-muted">E-mail confirmé</dt>
              <dd className="text-foreground">{user.email_confirmed_at ? formatDate(user.email_confirmed_at, true) : "Non"}</dd>
              <dt className="text-muted">Inscription</dt>
              <dd className="text-foreground">{formatDate(user.created_at, true)}</dd>
              <dt className="text-muted">Dernière connexion</dt>
              <dd className="text-foreground">{formatDate(user.last_sign_in_at, true)}</dd>
              <dt className="text-muted">Statut</dt>
              <dd>
                <AccountStatusBadge status={user.account_status} />
              </dd>
              <dt className="text-muted">Rôle plateforme</dt>
              <dd>
                <PlatformRoleBadge role={user.platform_role} />
              </dd>
              <dt className="text-muted">Abonnement</dt>
              <dd className="text-muted">— (Stripe, C7)</dd>
            </dl>
          </Panel>

          <section aria-labelledby="user-workspaces" className="flex flex-col gap-3">
            <h2 id="user-workspaces" className="text-base font-semibold text-foreground">
              Workspaces ({workspaces.length})
            </h2>
            <DataTable
              caption="Workspaces de l'utilisateur"
              empty={workspaces.length === 0 ? "Aucun workspace." : undefined}
              head={
                <>
                  <Th>Workspace</Th>
                  <Th>Rôle</Th>
                  <Th>Accès</Th>
                </>
              }
            >
              {workspaces.map((w) => (
                <tr key={w.workspace_id}>
                  <Td>
                    <Link href={`/admin/workspaces/${w.workspace_id}`} className="block">
                      <span className="block font-medium text-foreground">{w.name}</span>
                      <span className="block font-mono text-xs text-muted">/app/{w.slug}</span>
                    </Link>
                  </Td>
                  <Td>
                    <WorkspaceRoleBadge role={w.role} />
                  </Td>
                  <Td>
                    <AccessModeBadge mode={w.access_mode} active={w.access_active} />
                    {w.access_mode === "full_access" && w.ends_at ? (
                      <span className="ml-2 text-xs text-muted">jusqu&apos;au {formatDate(w.ends_at)}</span>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </DataTable>
          </section>
        </div>

        <aside className="flex flex-col gap-6">
          <Panel as="section" aria-labelledby="user-actions" className="p-6">
            <h2 id="user-actions" className="text-base font-semibold text-foreground">
              Actions
            </h2>
            {!canAct ? (
              <p className="mt-2 text-sm text-muted">Lecture seule pour votre rôle ({actor.role}).</p>
            ) : null}

            {can(actor.role, "users.suspend") ? (
              <div className="mt-4">
                {statusDecision.allowed ? (
                  <SuspendUserForm userId={user.id} suspended={user.account_status !== "active"} />
                ) : (
                  <p className="text-sm text-muted">{statusDecision.reason}</p>
                )}
              </div>
            ) : null}

            {can(actor.role, "users.change_role") ? (
              <div className="mt-6 border-t border-border pt-5">
                <SetRoleForm userId={user.id} currentRole={user.platform_role} options={roleOptions} />
              </div>
            ) : null}
          </Panel>

          <Panel as="section" aria-labelledby="user-fullaccess" className="p-6">
            <h2 id="user-fullaccess" className="text-base font-semibold text-foreground">
              Full Access
            </h2>
            <p className="mt-2 text-sm text-muted">
              Le Full Access s&apos;accorde par workspace : ouvrez la fiche du workspace concerné.
            </p>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
