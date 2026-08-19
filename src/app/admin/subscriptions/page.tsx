import type { Metadata } from "next";
import { CreditCard } from "lucide-react";
import { connection } from "next/server";

import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { requirePlatformRole } from "@/server/admin/authorization";

export const metadata: Metadata = {
  title: "Abonnements — POSTYNC Admin",
};

export default async function AdminSubscriptionsPage() {
  await connection();
  await requirePlatformRole();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Abonnements"
        description="Suivi des abonnements clients. Les accès offerts hors abonnement sont gérés via le Full Access des workspaces."
      />

      <section aria-label="Indicateurs" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Abonnements actifs" value={null} />
        <StatCard label="MRR" value={null} />
        <StatCard label="Essais en cours" value={null} />
        <StatCard label="Impayés" value={null} />
      </section>

      <EmptyState
        icon={<CreditCard className="h-5 w-5" />}
        title="La facturation Stripe sera configurée en C7."
        description="Les abonnements, factures et webhooks apparaîtront ici une fois l'intégration réalisée."
      />
    </div>
  );
}
