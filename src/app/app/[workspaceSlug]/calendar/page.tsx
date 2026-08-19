import type { Metadata } from "next";
import { connection } from "next/server";
import { CalendarDays } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { getWorkspaceContext } from "@/features/workspaces/context";

export const metadata: Metadata = {
  title: "Calendrier — POSTYNC",
};

export default async function CalendarPage({
  params,
}: PageProps<"/app/[workspaceSlug]/calendar">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  void ctx;

  const days = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Calendrier"
        description="Planifiez et visualisez vos publications à venir."
      />

      {/* Grille vide : aucune dépendance calendrier en C5. */}
      <Panel as="section" aria-label="Grille du calendrier" className="overflow-hidden">
        <div className="grid grid-cols-7 border-b border-border bg-surface-muted/60 text-center text-xs font-medium text-muted">
          {days.map((day) => (
            <div key={day} className="py-2">
              {day}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7" aria-hidden="true">
          {Array.from({ length: 35 }, (_, i) => (
            <div
              key={i}
              className="h-16 border-b border-r border-border/70 last:border-r-0 sm:h-20 [&:nth-child(7n)]:border-r-0"
            />
          ))}
        </div>
      </Panel>

      <EmptyState
        icon={<CalendarDays className="h-5 w-5" />}
        title="Vos publications programmées apparaîtront ici."
        description="Créez une publication et choisissez une date pour la retrouver dans le calendrier."
      />
    </div>
  );
}
