import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { Badge } from "@/components/admin/badges";
import { DataTable, Pagination, Td, Th } from "@/components/admin/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { auditActionLabel, formatDate, summarizeAudit } from "@/server/admin/audit";
import { requireAdminAction } from "@/server/admin/authorization";
import { listAuditLogs } from "@/server/admin/queries";

export const metadata: Metadata = {
  title: "Audit — POSTYNC Admin",
};

const PAGE_SIZE = 50;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function targetHref(type: string, id: string | null): string | null {
  if (!id) return null;
  if (type === "user") return `/admin/users/${id}`;
  if (type === "workspace") return `/admin/workspaces/${id}`;
  return null;
}

/** Journal des actions d'administration (admin et super_admin uniquement). */
export default async function AdminAuditPage({ searchParams }: PageProps<"/admin/audit">) {
  await connection();
  const actor = await requireAdminAction("audit.read");

  const params = await searchParams;
  const page = Math.max(1, Number.parseInt(first(params.page) || "1", 10) || 1);
  const { rows, total } = await listAuditLogs(actor, page, PAGE_SIZE);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit"
        description="Toutes les actions sensibles effectuées par l'équipe Kodeho. Aucun secret n'y est jamais journalisé."
      />

      <DataTable
        caption="Journal d'audit"
        empty={rows.length === 0 ? "Aucune action enregistrée pour le moment." : undefined}
        head={
          <>
            <Th>Date</Th>
            <Th>Admin</Th>
            <Th>Action</Th>
            <Th>Cible</Th>
            <Th>Résumé</Th>
          </>
        }
      >
        {rows.map((log) => {
          const href = targetHref(log.target_type, log.target_id);
          const shortId = log.target_id ? `${log.target_id.slice(0, 8)}…` : "—";
          return (
            <tr key={log.id}>
              <Td className="whitespace-nowrap text-muted">{formatDate(log.created_at, true)}</Td>
              <Td className="text-foreground">{log.actor_email ?? "—"}</Td>
              <Td>
                <Badge tone={log.action.endsWith("suspended") || log.action.endsWith("revoked") ? "danger" : "primary"}>
                  {auditActionLabel(log.action)}
                </Badge>
              </Td>
              <Td>
                <span className="text-xs text-muted">{log.target_type} </span>
                {href ? (
                  <Link href={href} className="font-mono text-xs text-primary hover:underline">
                    {shortId}
                  </Link>
                ) : (
                  <span className="font-mono text-xs">{shortId}</span>
                )}
              </Td>
              <Td className="text-muted">{summarizeAudit(log.action, log.metadata) || "—"}</Td>
            </tr>
          );
        })}
      </DataTable>

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        buildHref={(p) => (p > 1 ? `/admin/audit?page=${p}` : "/admin/audit")}
      />
    </div>
  );
}
