import type { Metadata } from "next";
import { connection } from "next/server";
import { BarChart3 } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { getWorkspaceContext } from "@/features/workspaces/context";

export const metadata: Metadata = {
  title: "Statistiques — POSTYNC",
};

export default async function AnalyticsPage({
  params,
}: PageProps<"/app/[workspaceSlug]/analytics">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  void ctx;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Statistiques"
        description="Suivez les performances de vos publications, réseau par réseau."
      />

      <section aria-label="Indicateurs" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Vues" value={null} />
        <StatCard label="Interactions" value={null} />
        <StatCard label="Abonnés gagnés" value={null} />
        <StatCard label="Publications" value={null} />
      </section>

      <EmptyState
        icon={<BarChart3 className="h-5 w-5" />}
        title="Les performances de vos publications apparaîtront ici."
        description="Les statistiques seront disponibles une fois vos premiers contenus publiés."
      />
    </div>
  );
}
