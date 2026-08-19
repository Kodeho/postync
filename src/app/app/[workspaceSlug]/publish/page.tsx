import type { Metadata } from "next";
import { connection } from "next/server";
import { Clock, Share2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { getWorkspaceContext } from "@/features/workspaces/context";

export const metadata: Metadata = {
  title: "Nouvelle publication — POSTYNC",
};

export default async function PublishPage({
  params,
}: PageProps<"/app/[workspaceSlug]/publish">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  void ctx;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Nouvelle publication"
        description="Importez un contenu puis choisissez les réseaux sur lesquels le publier."
      />

      {/* Squelette du futur workflow : contenu à gauche, réseaux et planification à droite. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Panel as="section" aria-labelledby="publish-content" className="p-6">
          <h2 id="publish-content" className="text-sm font-semibold text-foreground">
            1. Contenu
          </h2>
          <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-dashed border-border-strong bg-surface-muted/60 px-6 py-14 text-center">
            <span
              aria-hidden="true"
              className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-full bg-surface text-muted shadow-soft"
            >
              <Upload className="h-5 w-5" />
            </span>
            <p className="text-sm font-medium text-foreground">Déposez une vidéo ou une image</p>
            <p className="mt-1 text-sm text-muted">L&apos;import de médias arrive dans une prochaine étape.</p>
            <Button variant="secondary" className="mt-5" disabled>
              Importer un contenu
            </Button>
          </div>
          <label className="mt-6 flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">Légende</span>
            <textarea
              rows={4}
              disabled
              placeholder="Votre texte sera publié sur chaque réseau sélectionné."
              className="rounded-md border border-border bg-surface-muted/60 px-3 py-2 text-sm placeholder:text-muted-soft disabled:cursor-not-allowed"
            />
          </label>
        </Panel>

        <div className="flex flex-col gap-6">
          <Panel as="section" aria-labelledby="publish-networks" className="p-6">
            <h2 id="publish-networks" className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Share2 aria-hidden="true" className="h-4 w-4 text-muted" />
              2. Réseaux
            </h2>
            <p className="mt-2 text-sm text-muted">
              Aucun compte connecté. Les réseaux disponibles apparaîtront ici.
            </p>
          </Panel>
          <Panel as="section" aria-labelledby="publish-schedule" className="p-6">
            <h2 id="publish-schedule" className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Clock aria-hidden="true" className="h-4 w-4 text-muted" />
              3. Planification
            </h2>
            <p className="mt-2 text-sm text-muted">Publier maintenant ou programmer une date.</p>
            <Button className="mt-5 w-full" disabled>
              Publier
            </Button>
          </Panel>
        </div>
      </div>
    </div>
  );
}
