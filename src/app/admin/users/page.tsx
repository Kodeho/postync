import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { AccountStatusBadge, PlatformRoleBadge } from "@/components/admin/badges";
import { DataTable, Pagination, Td, Th } from "@/components/admin/data-table";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/server/admin/audit";
import { requirePlatformRole } from "@/server/admin/authorization";
import { listUsers, type AccountStatus } from "@/server/admin/queries";

export const metadata: Metadata = {
  title: "Utilisateurs — POSTYNC Admin",
};

const PAGE_SIZE = 25;
const STATUSES: AccountStatus[] = ["active", "suspended", "disabled"];
const ROLES = ["user", "support", "admin", "super_admin"];

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function AdminUsersPage({ searchParams }: PageProps<"/admin/users">) {
  await connection();
  const actor = await requirePlatformRole();

  const params = await searchParams;
  const search = first(params.q).slice(0, 100);
  const statusRaw = first(params.status);
  const roleRaw = first(params.role);
  const status = (STATUSES as string[]).includes(statusRaw) ? (statusRaw as AccountStatus) : null;
  const role = ROLES.includes(roleRaw) ? roleRaw : null;
  const page = Math.max(1, Number.parseInt(first(params.page) || "1", 10) || 1);

  const { rows, total } = await listUsers(actor, { search, status, role, page, pageSize: PAGE_SIZE });

  const buildHref = (p: number) => {
    const q = new URLSearchParams();
    if (search) q.set("q", search);
    if (status) q.set("status", status);
    if (role) q.set("role", role);
    if (p > 1) q.set("page", String(p));
    const qs = q.toString();
    return `/admin/users${qs ? `?${qs}` : ""}`;
  };

  const selectClass =
    "h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground shadow-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Utilisateurs" description={`${total} compte${total > 1 ? "s" : ""} sur la plateforme.`} />

      <form method="get" action="/admin/users" className="flex flex-wrap items-end gap-3" role="search">
        <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Recherche</span>
          <input
            type="search"
            name="q"
            defaultValue={search}
            placeholder="Nom ou e-mail"
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm shadow-soft placeholder:text-muted-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Statut</span>
          <select name="status" defaultValue={status ?? ""} className={selectClass}>
            <option value="">Tous</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Rôle plateforme</span>
          <select name="role" defaultValue={role ?? ""} className={selectClass}>
            <option value="">Tous</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Filtrer
        </Button>
      </form>

      <DataTable
        caption="Liste des utilisateurs"
        empty={rows.length === 0 ? "Aucun utilisateur ne correspond à ces critères." : undefined}
        head={
          <>
            <Th>Utilisateur</Th>
            <Th>Statut</Th>
            <Th>Rôle</Th>
            <Th className="text-right">Workspaces</Th>
            <Th>Inscription</Th>
            <Th>Dernière connexion</Th>
          </>
        }
      >
        {rows.map((u) => (
          <tr key={u.id} className="hover:bg-surface-muted/50">
            <Td>
              <Link href={`/admin/users/${u.id}`} className="block">
                <span className="block font-medium text-foreground">{u.display_name ?? "—"}</span>
                <span className="block text-xs text-muted">{u.email}</span>
              </Link>
            </Td>
            <Td>
              <AccountStatusBadge status={u.account_status} />
            </Td>
            <Td>
              <PlatformRoleBadge role={u.platform_role} />
            </Td>
            <Td className="text-right tabular-nums">{u.workspace_count}</Td>
            <Td className="text-muted">{formatDate(u.created_at)}</Td>
            <Td className="text-muted">{formatDate(u.last_sign_in_at, true)}</Td>
          </tr>
        ))}
      </DataTable>

      <Pagination page={page} pageSize={PAGE_SIZE} total={total} buildHref={buildHref} />
    </div>
  );
}
