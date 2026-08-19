import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { AccessModeBadge } from "@/components/admin/badges";
import { DataTable, Pagination, Td, Th } from "@/components/admin/data-table";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/server/admin/audit";
import { requirePlatformRole } from "@/server/admin/authorization";
import { listWorkspaces } from "@/server/admin/queries";

export const metadata: Metadata = {
  title: "Workspaces — POSTYNC Admin",
};

const PAGE_SIZE = 25;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function AdminWorkspacesPage({ searchParams }: PageProps<"/admin/workspaces">) {
  await connection();
  const actor = await requirePlatformRole();

  const params = await searchParams;
  const search = first(params.q).slice(0, 100);
  const page = Math.max(1, Number.parseInt(first(params.page) || "1", 10) || 1);
  const { rows, total } = await listWorkspaces(actor, { search, page, pageSize: PAGE_SIZE });

  const buildHref = (p: number) => {
    const q = new URLSearchParams();
    if (search) q.set("q", search);
    if (p > 1) q.set("page", String(p));
    const qs = q.toString();
    return `/admin/workspaces${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Workspaces" description={`${total} workspace${total > 1 ? "s" : ""}.`} />

      <form method="get" action="/admin/workspaces" className="flex flex-wrap items-end gap-3" role="search">
        <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Recherche</span>
          <input
            type="search"
            name="q"
            defaultValue={search}
            placeholder="Nom, slug ou propriétaire"
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm shadow-soft placeholder:text-muted-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
          />
        </label>
        <Button type="submit" variant="secondary">
          Rechercher
        </Button>
      </form>

      <DataTable
        caption="Liste des workspaces"
        empty={rows.length === 0 ? "Aucun workspace ne correspond." : undefined}
        head={
          <>
            <Th>Workspace</Th>
            <Th>Propriétaire</Th>
            <Th className="text-right">Membres</Th>
            <Th>Accès</Th>
            <Th>Abonnement</Th>
            <Th>Création</Th>
          </>
        }
      >
        {rows.map((w) => (
          <tr key={w.id} className="hover:bg-surface-muted/50">
            <Td>
              <Link href={`/admin/workspaces/${w.id}`} className="block">
                <span className="block font-medium text-foreground">{w.name}</span>
                <span className="block font-mono text-xs text-muted">/app/{w.slug}</span>
              </Link>
            </Td>
            <Td>
              <Link href={`/admin/users/${w.owner_id}`} className="block">
                <span className="block text-foreground">{w.owner_name ?? "—"}</span>
                <span className="block text-xs text-muted">{w.owner_email}</span>
              </Link>
            </Td>
            <Td className="text-right tabular-nums">{w.member_count}</Td>
            <Td>
              <AccessModeBadge mode={w.access_mode} active={w.access_active} />
            </Td>
            <Td className="text-muted">—</Td>
            <Td className="text-muted">{formatDate(w.created_at)}</Td>
          </tr>
        ))}
      </DataTable>

      <Pagination page={page} pageSize={PAGE_SIZE} total={total} buildHref={buildHref} />
    </div>
  );
}
