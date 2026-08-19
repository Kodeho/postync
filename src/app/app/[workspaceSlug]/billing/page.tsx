import type { Metadata } from "next";
import { connection } from "next/server";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { getWorkspaceContext } from "@/features/workspaces/context";

export const metadata: Metadata = {
  title: "Abonnement — POSTYNC",
};

export default async function BillingPage({
  params,
}: PageProps<"/app/[workspaceSlug]/billing">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  void ctx;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Abonnement"
        description="Le plan et la facturation de ce workspace."
      />

      <Panel as="section" aria-labelledby="billing-plan" className="p-6">
        <h2 id="billing-plan" className="text-sm text-muted">
          Plan actuel
        </h2>
        <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Non configuré</p>
        <p className="mt-4 text-sm text-muted">La gestion des abonnements arrive bientôt.</p>
      </Panel>
    </div>
  );
}
