import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { requirePlatformRole } from "@/server/admin/authorization";
import { getDashboardStats } from "@/server/admin/queries";

export const metadata: Metadata = {
  title: "Dashboard — POSTYNC Admin",
};

/**
 * Dashboard plateforme. Utilisateurs / workspaces / actifs / suspendus
 * proviennent de la base (RPC admin_dashboard_stats). Les métriques dont les
 * tables n'existent pas encore (abonnements, MRR, publications, incidents)
 * sont affichées « — ».
 */
export default async function AdminDashboardPage() {
  await connection();
  const actor = await requirePlatformRole();
  const stats = await getDashboardStats(actor);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Dashboard"
        description="Vue d'ensemble de la plateforme POSTYNC."
      />

      <section aria-label="Comptes et workspaces" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Utilisateurs" value={stats?.users_total ?? null} />
        <StatCard label="Workspaces" value={stats?.workspaces_total ?? null} />
        <StatCard label="Utilisateurs actifs" value={stats?.users_active ?? null} />
        <StatCard label="Comptes suspendus" value={stats?.users_suspended ?? null} />
      </section>

      <section aria-label="Activité et revenus" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Abonnements actifs" value={null} hint="Stripe — C7" />
        <StatCard label="MRR" value={null} hint="Stripe — C7" />
        <StatCard label="Publications aujourd'hui" value={null} hint="Moteur de publication — à venir" />
        <StatCard label="Incidents" value={null} hint="Supervision — à venir" />
      </section>

      <section aria-label="Droits commerciaux" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Workspaces en Full Access"
          value={stats?.full_access_workspaces ?? null}
          hint="Hors abonnement (workspace_entitlements)"
        />
      </section>

      <p className="text-sm text-muted">
        Gérer les{" "}
        <Link href="/admin/users" className="font-medium text-primary hover:underline">
          utilisateurs
        </Link>{" "}
        et les{" "}
        <Link href="/admin/workspaces" className="font-medium text-primary hover:underline">
          workspaces
        </Link>
        .
      </p>
    </div>
  );
}
