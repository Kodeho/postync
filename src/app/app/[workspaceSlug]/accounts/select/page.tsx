import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { AssetSelectionForm } from "@/features/accounts/asset-selection-form";
import { getWorkspaceContext } from "@/features/workspaces/context";
import { requireUser } from "@/features/workspaces/queries";
import { getWorkspaceAccess } from "@/server/billing/queries";
import { PLATFORM_LABELS } from "@/server/social/accounts";
import { listSelectableAssets } from "@/server/social/assets";
import { getProvider } from "@/server/social/providers";
import { createServiceClient } from "@/server/supabase/service-client";
import type { SocialPlatform } from "@/types/platform";

export const metadata: Metadata = {
  title: "Choisir les Pages — POSTYNC",
};

/**
 * Écran de sélection des actifs (Pages Facebook).
 *
 * Atteint uniquement au retour d'un OAuth dont la plateforme expose
 * PLUSIEURS comptes publiables. L'URL ne porte qu'un identifiant de
 * brouillon ; le brouillon lui-même est lié au workspace ET à l'utilisateur,
 * et le jeton qu'il protège ne quitte jamais le serveur.
 */
export default async function SelectAssetsPage({
  params,
  searchParams,
}: PageProps<"/app/[workspaceSlug]/accounts/select">) {
  await connection();

  const { workspaceSlug } = await params;
  const query = await searchParams;
  const ctx = await getWorkspaceContext(workspaceSlug);
  const workspace = ctx.active.workspace;

  // Même règle que la connexion : seuls owner et admin gèrent les comptes.
  if (ctx.active.role !== "owner" && ctx.active.role !== "admin") {
    redirect(`/app/${workspace.slug}/accounts`);
  }

  const draftId = typeof query.draft === "string" ? query.draft : "";
  if (!draftId) {
    redirect(`/app/${workspace.slug}/accounts`);
  }

  const { user, supabase } = await requireUser();
  const result = await listSelectableAssets(
    {
      db: createServiceClient(),
      getProvider: (platform: string) => getProvider(platform as SocialPlatform),
      getQuota: async (workspaceId: string) => {
        const { access } = await getWorkspaceAccess(supabase, workspaceId);
        return access.quotas.socialAccounts;
      },
    },
    { draftId, workspaceId: workspace.id, userId: user.id },
  );

  if (!result.ok) {
    // Brouillon expiré, déjà consommé, ou appartenant à quelqu'un d'autre :
    // on renvoie vers la page des comptes avec un code court.
    redirect(`/app/${workspace.slug}/accounts?error=${result.code}`);
  }

  const publishable = result.assets.filter((asset) => asset.canPublish);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={`Choisir les Pages ${PLATFORM_LABELS[result.platform]}`}
        description="Chaque Page connectée compte comme un compte social dans votre plan. Vous pourrez en ajouter ou en retirer à tout moment."
      />

      <Panel className="p-5">
        {result.assets.length === 0 ? (
          <EmptyState
            title="Aucune Page trouvée"
            description="Ce compte n'administre aucune Page, ou vous n'avez pas accordé l'accès aux Pages lors de l'autorisation. Créez une Page ou relancez la connexion."
          />
        ) : publishable.length === 0 ? (
          <EmptyState
            title="Aucune Page publiable"
            description="Vous n'avez le droit de publier sur aucune de ces Pages. Demandez la permission de création de contenu, puis relancez la connexion."
          />
        ) : (
          <AssetSelectionForm
            workspaceSlug={workspace.slug}
            draftId={draftId}
            assets={result.assets}
          />
        )}
      </Panel>
    </div>
  );
}
