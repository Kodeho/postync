import type { Metadata } from "next";
import { CreditCard } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";

import { Badge } from "@/components/admin/badges";
import { DataTable, Pagination, Td, Th } from "@/components/admin/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { formatPlanPrice } from "@/config/plans";
import { formatDate } from "@/server/admin/audit";
import { requirePlatformRole } from "@/server/admin/authorization";
import { getBillingStats, listSubscriptions } from "@/server/admin/billing-queries";
import {
  SUBSCRIPTION_STATUS_LABELS,
  isSubscriptionStatus,
} from "@/server/billing/access";
import { isStripeConfigured } from "@/server/stripe/config";

export const metadata: Metadata = {
  title: "Abonnements — POSTYNC Admin",
};

const PAGE_SIZE = 50;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "active" || status === "trialing") return "success";
  if (status === "past_due" || status === "paused" || status === "incomplete") return "warning";
  if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") return "danger";
  return "neutral";
}

export default async function AdminSubscriptionsPage({
  searchParams,
}: PageProps<"/admin/subscriptions">) {
  await connection();
  const actor = await requirePlatformRole();

  const params = await searchParams;
  const page = Math.max(1, Number.parseInt(first(params.page) || "1", 10) || 1);

  const [{ rows, total }, stats] = await Promise.all([
    listSubscriptions(actor, page, PAGE_SIZE),
    getBillingStats(actor),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Abonnements"
        description="Abonnements Stripe synchronisés par webhook. Les accès offerts hors abonnement sont gérés via le Full Access des workspaces."
      />

      <section aria-label="Indicateurs" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Abonnements actifs"
          value={stats?.activeSubscriptions ?? null}
          hint="active + trialing"
        />
        <StatCard
          label="MRR"
          value={stats ? formatPlanPrice(stats.mrrCents) : null}
          hint="Prix de référence ; annuel / 12"
        />
        <StatCard label="Essais en cours" value={null} hint="À venir" />
        <StatCard label="Impayés" value={null} hint="À venir" />
      </section>

      {rows.length === 0 ? (
        <EmptyState
          icon={<CreditCard className="h-5 w-5" />}
          title={
            isStripeConfigured()
              ? "Aucun abonnement pour le moment."
              : "Stripe n'est pas encore configuré sur cette installation."
          }
          description="Les abonnements souscrits via Stripe Checkout apparaîtront ici, synchronisés par le webhook."
        />
      ) : (
        <>
          <DataTable
            caption="Liste des abonnements"
            head={
              <>
                <Th>Workspace</Th>
                <Th>Client</Th>
                <Th>Plan</Th>
                <Th>Périodicité</Th>
                <Th>Statut</Th>
                <Th>Renouvellement</Th>
                <Th>Full Access</Th>
              </>
            }
          >
            {rows.map((s) => (
              <tr key={s.id} className="hover:bg-surface-muted/50">
                <Td>
                  <Link href={`/admin/workspaces/${s.workspace_id}`} className="block">
                    <span className="block font-medium text-foreground">{s.workspace_name}</span>
                    <span className="block font-mono text-xs text-muted">/app/{s.workspace_slug}</span>
                  </Link>
                </Td>
                <Td className="text-muted">{s.owner_email}</Td>
                <Td>
                  <Badge tone={s.plan_key === "unknown" ? "warning" : "primary"}>{s.plan_key}</Badge>
                </Td>
                <Td className="text-muted">
                  {s.billing_interval === "year" ? "Annuel" : s.billing_interval === "month" ? "Mensuel" : "—"}
                </Td>
                <Td>
                  <Badge tone={statusTone(s.status)}>
                    {isSubscriptionStatus(s.status) ? SUBSCRIPTION_STATUS_LABELS[s.status] : s.status}
                  </Badge>
                  {s.cancel_at_period_end ? (
                    <span className="ml-2 text-xs text-muted">fin de période</span>
                  ) : null}
                </Td>
                <Td className="text-muted">{formatDate(s.current_period_end)}</Td>
                <Td>{s.full_access ? <Badge tone="success">full_access</Badge> : <span className="text-muted">—</span>}</Td>
              </tr>
            ))}
          </DataTable>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            buildHref={(p) => (p > 1 ? `/admin/subscriptions?page=${p}` : "/admin/subscriptions")}
          />
        </>
      )}
    </div>
  );
}
