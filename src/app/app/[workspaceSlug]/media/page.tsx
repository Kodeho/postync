import type { Metadata } from "next";
import { connection } from "next/server";
import { Images, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getWorkspaceContext } from "@/features/workspaces/context";

export const metadata: Metadata = {
  title: "Médiathèque — POSTYNC",
};

export default async function MediaPage({
  params,
}: PageProps<"/app/[workspaceSlug]/media">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  void ctx;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Médiathèque"
        description="Tous les médias de ce workspace, prêts à être publiés."
        actions={
          <Button disabled title="L'import de médias arrive bientôt">
            <Upload aria-hidden="true" className="h-4 w-4" />
            Importer un média
          </Button>
        }
      />

      <EmptyState
        icon={<Images className="h-5 w-5" />}
        title="Vos photos et vidéos apparaîtront ici."
        description="Importez un média une seule fois, puis publiez-le sur tous vos réseaux."
      />
    </div>
  );
}
