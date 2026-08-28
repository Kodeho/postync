import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { CalendarDays } from "lucide-react";

import { Badge } from "@/components/admin/badges";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { CancelScheduledButton } from "@/features/calendar/cancel-button";
import { RescheduleButton } from "@/features/calendar/reschedule-button";
import { getWorkspaceContext } from "@/features/workspaces/context";
import { createClient } from "@/lib/supabase/server";
import {
  MEDIA_KIND_LABELS,
  PLATFORM_LABELS,
  PUBLICATION_STATUS_LABELS,
  type SocialPublicationStatus,
} from "@/server/social/accounts";
import {
  adjacentMonths,
  buildMonthGrid,
  isValidMonth,
  listPublicationsForMonth,
  type CalendarEntry,
} from "@/server/social/calendar";

export const metadata: Metadata = {
  title: "Calendrier — POSTYNC",
};

/**
 * Calendrier des publications (C10.3).
 *
 * Le mois affiché vient de l'URL, ce qui rend chaque vue partageable et
 * navigable sans état client. Un paramètre invalide retombe sur le mois
 * courant plutôt que de casser la page.
 *
 * Le fuseau est celui du serveur, EXPLICITE. Sans lui, une publication
 * programmée à 00h30 apparaîtrait la veille — le genre d'erreur qui ne se voit
 * qu'aux extrémités du mois.
 */

const JOURS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

const TONS: Record<SocialPublicationStatus, "success" | "warning" | "danger" | "neutral"> = {
  scheduled: "warning",
  pending: "warning",
  published: "success",
  failed: "danger",
  canceled: "neutral",
};

function moisCourant(timeZone: string): string {
  const [annee, mois] = new Date().toLocaleDateString("en-CA", { timeZone }).split("-");
  return `${annee}-${mois}`;
}

function libelleMois(month: string): string {
  const [annee, mois] = month.split("-").map(Number);
  return new Date(Date.UTC(annee, mois - 1, 1)).toLocaleDateString("fr-FR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function heure(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

export default async function CalendarPage({
  params,
  searchParams,
}: PageProps<"/app/[workspaceSlug]/calendar">) {
  await connection();

  const { workspaceSlug } = await params;
  const query = await searchParams;
  const ctx = await getWorkspaceContext(workspaceSlug);
  const workspace = ctx.active.workspace;
  const canManage = ctx.active.role === "owner" || ctx.active.role === "admin";

  // Le fuseau du WORKSPACE, pas celui du serveur ni du navigateur : c'est la
  // référence commune de tous les écrans depuis C13.
  const timeZone = workspace.time_zone;
  const demande = typeof query.mois === "string" ? query.mois : undefined;
  const mois = isValidMonth(demande) ? demande : moisCourant(timeZone);

  const supabase = await createClient();
  const publications = await listPublicationsForMonth(supabase, workspace.id, mois);
  const grille = buildMonthGrid(mois, publications, timeZone);
  const { previous, next } = adjacentMonths(mois);

  const aujourdhui = new Date().toLocaleDateString("en-CA", { timeZone });
  const programmees = publications.filter((p) => p.status === "scheduled").length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Calendrier"
        description={
          programmees > 0
            ? `${programmees} publication(s) programmée(s) ce mois-ci. Elles partiront automatiquement à l'heure prévue.`
            : "Vos publications, passées et à venir. Programmez une échéance depuis un compte social."
        }
      />

      <Panel as="section" aria-label="Grille du calendrier" className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <Link
            href={`/app/${workspace.slug}/calendar?mois=${previous}`}
            className="text-sm text-primary underline-offset-4 hover:underline"
            rel="nofollow"
          >
            ← {libelleMois(previous)}
          </Link>
          <h2 className="text-sm font-semibold capitalize text-foreground">{libelleMois(mois)}</h2>
          <Link
            href={`/app/${workspace.slug}/calendar?mois=${next}`}
            className="text-sm text-primary underline-offset-4 hover:underline"
            rel="nofollow"
          >
            {libelleMois(next)} →
          </Link>
        </div>

        <div className="grid grid-cols-7 border-b border-border bg-surface-muted/60 text-center text-xs font-medium text-muted">
          {JOURS.map((jour) => (
            <div key={jour} className="py-2">
              {jour}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {grille.map((jour) => (
            <div
              key={jour.date}
              className={`min-h-24 border-b border-r border-border/70 p-1.5 last:border-r-0 [&:nth-child(7n)]:border-r-0 ${
                jour.inMonth ? "" : "bg-surface-muted/40"
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-xs ${
                    jour.date === aujourdhui
                      ? "flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                      : jour.inMonth
                        ? "text-foreground"
                        : "text-muted-soft"
                  }`}
                >
                  {jour.dayOfMonth}
                </span>
              </div>

              <ul className="mt-1 flex flex-col gap-1">
                {jour.entries.map((entree) => (
                  <li key={entree.id}>
                    <EntreeCalendrier
                      entree={entree}
                      workspaceSlug={workspace.slug}
                      canManage={canManage}
                      timeZone={timeZone}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Panel>

      {publications.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-5 w-5" />}
          title="Aucune publication ce mois-ci."
          description="Depuis Comptes sociaux, choisissez « Programmer » pour fixer une date : la publication partira toute seule."
        />
      ) : null}
    </div>
  );
}

function EntreeCalendrier({
  entree,
  workspaceSlug,
  canManage,
  timeZone,
}: {
  entree: CalendarEntry;
  workspaceSlug: string;
  canManage: boolean;
  timeZone: string;
}) {
  const contenu = (
    <div className="rounded border border-border bg-surface p-1.5">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-[11px] font-medium text-foreground">
          {heure(entree.occursAt, timeZone)} · {PLATFORM_LABELS[entree.platform]}
        </span>
        <Badge tone={TONS[entree.status]}>{PUBLICATION_STATUS_LABELS[entree.status]}</Badge>
      </div>
      <p className="truncate text-[11px] text-muted">
        {MEDIA_KIND_LABELS[entree.media_kind]}
        {entree.caption ? ` — ${entree.caption}` : ""}
      </p>
      {entree.status === "failed" && entree.status_detail ? (
        <p className="truncate text-[11px] text-danger">{entree.status_detail}</p>
      ) : null}
      {entree.status === "scheduled" && canManage ? (
        <div className="flex flex-col gap-1">
          <RescheduleButton
            workspaceSlug={workspaceSlug}
            publicationId={entree.id}
            currentIso={entree.occursAt}
            timeZone={timeZone}
          />
          <CancelScheduledButton workspaceSlug={workspaceSlug} publicationId={entree.id} />
        </div>
      ) : null}
    </div>
  );

  // Une publication en ligne mène à elle-même ; les autres n'ont rien à ouvrir.
  return entree.permalink ? (
    <a href={entree.permalink} target="_blank" rel="noreferrer noopener" className="block">
      {contenu}
    </a>
  ) : (
    contenu
  );
}
