import type { Metadata } from "next";
import { Plus, Share2, Send } from "lucide-react";
import { connection } from "next/server";

import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { getWorkspaceContext, userFirstName } from "@/features/workspaces/context";
import { workspaceHref } from "@/features/workspaces/navigation";

export const metadata: Metadata = {
  title: "Vue d'ensemble — POSTYNC",
};

/**
 * Vue d'ensemble du workspace actif.
 *
 * Les statistiques sont des emplacements explicites (« — ») : aucune donnée
 * métier n'existe encore. L'identité (prénom, workspace) vient de la base.
 */
export default async function OverviewPage({
  params,
}: PageProps<"/app/[workspaceSlug]">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  const slug = ctx.active.workspace.slug;
  const firstName = userFirstName(ctx);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={firstName ? `Bonjour ${firstName}` : "Bonjour"}
        description="Voici ce qui se passe aujourd'hui sur vos réseaux."
        actions={
          <ButtonLink href={workspaceHref(slug, "publish")}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Nouvelle publication
          </ButtonLink>
        }
      />

      <section aria-label="Résumé du jour" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Publications aujourd'hui" value={null} />
        <StatCard label="Programmées" value={null} />
        <StatCard label="Réussies" value={null} />
        <StatCard label="Erreurs" value={null} />
      </section>

      <EmptyState
        icon={<Send className="h-5 w-5" />}
        title="Aucune publication pour le moment."
        description="Connectez vos réseaux sociaux et publiez votre premier contenu."
        actions={
          <>
            <ButtonLink href={workspaceHref(slug, "accounts")} variant="secondary">
              <Share2 aria-hidden="true" className="h-4 w-4" />
              Connecter un compte
            </ButtonLink>
            <ButtonLink href={workspaceHref(slug, "publish")}>
              Créer une publication
            </ButtonLink>
          </>
        }
      />
    </div>
  );
}
