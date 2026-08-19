import type { Metadata } from "next";
import { connection } from "next/server";

import { DataTable, Td, Th } from "@/components/admin/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { PLANS, formatPlanPrice } from "@/config/plans";
import { requirePlatformRole } from "@/server/admin/authorization";

export const metadata: Metadata = {
  title: "Plans — POSTYNC Admin",
};

export default async function AdminPlansPage() {
  await connection();
  await requirePlatformRole();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Plans"
        description="Offres de référence (src/config/plans.ts). Prix et quotas indicatifs : rien n'est encore facturé ni appliqué ; Stripe (C7) et les quotas (C8) consommeront cette configuration."
      />

      <DataTable
        caption="Plans POSTYNC"
        head={
          <>
            <Th>Plan</Th>
            <Th className="text-right">Prix / mois</Th>
            <Th className="text-right">Workspaces</Th>
            <Th className="text-right">Comptes sociaux</Th>
            <Th className="text-right">Publications / mois</Th>
            <Th className="text-right">Stockage</Th>
          </>
        }
      >
        {PLANS.map((plan) => (
          <tr key={plan.key}>
            <Td>
              <span className="block font-medium text-foreground">{plan.name}</span>
              <span className="block text-xs text-muted">{plan.description}</span>
            </Td>
            <Td className="text-right font-medium tabular-nums text-foreground">
              {formatPlanPrice(plan.monthlyPriceCents)}
            </Td>
            <Td className="text-right tabular-nums">{plan.quotas.workspaces}</Td>
            <Td className="text-right tabular-nums">{plan.quotas.socialAccounts}</Td>
            <Td className="text-right tabular-nums">
              {plan.quotas.publicationsPerMonth.toLocaleString("fr-FR")}
            </Td>
            <Td className="text-right tabular-nums">{plan.quotas.storageGb} Go</Td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
