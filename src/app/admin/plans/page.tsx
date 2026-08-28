import type { Metadata } from "next";
import { connection } from "next/server";

import { DataTable, Td, Th } from "@/components/admin/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/admin/badges";
import { Panel } from "@/components/ui/panel";
import { PLANS, formatPlanPrice } from "@/config/plans";
import { requirePlatformRole } from "@/server/admin/authorization";
import { priceConfigurationStatus } from "@/server/stripe/config";

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
        description="Offres de référence (src/config/plans.ts). Les montants réellement facturés sont pilotés par les Price IDs Stripe ; les quotas seront appliqués en C8."
      />

      <DataTable
        caption="Plans POSTYNC"
        head={
          <>
            <Th>Plan</Th>
            <Th className="text-right">Mensuel</Th>
            <Th className="text-right">Annuel</Th>
            <Th className="text-right">Workspaces</Th>
            <Th className="text-right">Membres</Th>
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
            <Td className="text-right tabular-nums text-foreground">
              {plan.yearlyPriceCents > 0 ? formatPlanPrice(plan.yearlyPriceCents) : "—"}
            </Td>
            <Td className="text-right tabular-nums">{plan.quotas.workspaces}</Td>
            <Td className="text-right tabular-nums">{plan.quotas.members}</Td>
            <Td className="text-right tabular-nums">{plan.quotas.socialAccounts}</Td>
            <Td className="text-right tabular-nums">
              {plan.quotas.publicationsPerMonth.toLocaleString("fr-FR")}
            </Td>
            <Td className="text-right tabular-nums">{plan.quotas.storageGb} Go</Td>
          </tr>
        ))}
      </DataTable>

      <Panel as="section" aria-labelledby="plans-prices" className="overflow-hidden">
        <div className="border-b border-border px-6 py-4">
          <h2 id="plans-prices" className="text-base font-semibold text-foreground">
            Price IDs Stripe
          </h2>
          <p className="mt-1 text-sm text-muted">
            Présence des variables d&apos;environnement — les valeurs ne sont jamais
            affichées. Le plan Free n&apos;a pas de Price Stripe.
          </p>
        </div>
        <ul className="divide-y divide-border">
          {priceConfigurationStatus().map((row) => (
            <li key={row.envName} className="flex items-center gap-4 px-6 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium capitalize text-foreground">
                  {row.planKey} — {row.interval === "year" ? "annuel" : "mensuel"}
                </p>
                <p className="font-mono text-xs text-muted">{row.envName}</p>
              </div>
              <Badge tone={row.configured ? "success" : "neutral"}>
                {row.configured ? "Configuré" : "Non configuré"}
              </Badge>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
