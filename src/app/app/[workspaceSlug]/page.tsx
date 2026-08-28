import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, Plus, Send, Share2 } from "lucide-react";
import { connection } from "next/server";

import { Badge } from "@/components/admin/badges";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import { getWorkspaceContext, userFirstName } from "@/features/workspaces/context";
import { workspaceHref } from "@/features/workspaces/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  MEDIA_KIND_LABELS,
  PLATFORM_LABELS,
  SOCIAL_STATUS_LABELS,
} from "@/server/social/accounts";
import { occurrenceOf } from "@/server/social/calendar";
import {
  buildOverview,
  listOverviewPublications,
  type AttentionItem,
} from "@/server/social/overview";
import { listSocialAccounts } from "@/server/social/queries";

export const metadata: Metadata = {
  title: "Vue d'ensemble — POSTYNC",
};

/**
 * Vue d'ensemble du workspace (C12).
 *
 * Elle affichait quatre tirets et « Aucune publication pour le moment » à un
 * workspace qui en comptait huit. Un premier écran qui ment sur l'état du
 * compte apprend à l'utilisateur à ne pas s'y fier.
 *
 * L'ordre des sections n'est pas décoratif : CE QUI EXIGE UNE ACTION vient en
 * premier. Programmer sert à ne pas surveiller ; si un échec de 3 h du matin
 * n'apparaît qu'au fond d'un calendrier, la fonction ne tient pas sa promesse.
 */

/**
 * Traduction des codes d'échec. Un code inconnu s'affiche tel quel : brut, il
 * reste plus utile qu'un « une erreur est survenue » qui n'apprend rien.
 */
const RAISONS: Record<string, string> = {
  container_failed: "la plateforme a rejeté le média.",
  container_expired: "le média préparé a expiré côté plateforme.",
  too_many_attempts: "trop de tentatives : la publication a été abandonnée.",
  account_disconnected: "le compte a été déconnecté avant l'échéance.",
  publish_auth_invalid: "l'autorisation du compte n'est plus valide.",
  http_400: "la plateforme a refusé la demande.",
};

/**
 * Instant de rendu, lu UNE seule fois.
 *
 * Les compteurs et les listes doivent raisonner sur le même instant : deux
 * lectures d'horloge à quelques millisecondes d'écart suffiraient, à cheval
 * sur minuit, à produire une page qui se contredit elle-même.
 */
function instantDeRendu(): number {
  return Date.now();
}

function heure(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
}

export default async function OverviewPage({ params }: PageProps<"/app/[workspaceSlug]">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  const slug = ctx.active.workspace.slug;
  const firstName = userFirstName(ctx);

  const maintenant = instantDeRendu();
  const supabase = await createClient();
  const [publications, comptes] = await Promise.all([
    listOverviewPublications(supabase, ctx.active.workspace.id, maintenant),
    listSocialAccounts(supabase, ctx.active.workspace.id),
  ]);

  // Le fuseau du WORKSPACE : les compteurs « aujourd'hui » et « ce mois-ci »
  // n'ont de sens que rapportés à la même référence que le calendrier.
  const timeZone = ctx.active.workspace.time_zone;
  const vue = buildOverview(publications, comptes, { now: maintenant, timeZone });

  const vierge = publications.length === 0 && comptes.length === 0;

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

      {/* EN PREMIER : ce qui demande une décision. Tout le reste peut attendre. */}
      {vue.attention.length > 0 ? (
        <Panel
          as="section"
          aria-labelledby="a-traiter"
          className="border-danger/30 bg-danger-soft/40 p-5"
        >
          <h2
            id="a-traiter"
            className="flex items-center gap-2 text-sm font-semibold text-foreground"
          >
            <AlertTriangle aria-hidden="true" className="h-4 w-4 text-danger" />
            À traiter
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {vue.attention.map((item) => (
              <li key={cle(item)}>
                <LigneAttention item={item} slug={slug} timeZone={timeZone} />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <section aria-label="Résumé" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Publiées aujourd'hui" value={vue.counts.publishedToday} />
        <StatCard label="Programmées" value={vue.counts.upcoming} />
        <StatCard label="Publiées ce mois-ci" value={vue.counts.publishedThisMonth} />
        <StatCard
          label="En échec"
          value={vue.counts.failedRecently}
          hint="Sur les 14 derniers jours"
        />
      </section>

      {vue.upcoming.length > 0 ? (
        <Panel as="section" aria-labelledby="a-venir" className="p-5">
          <div className="flex items-center justify-between">
            <h2 id="a-venir" className="text-sm font-semibold text-foreground">
              Prochaines publications
            </h2>
            <Link
              href={workspaceHref(slug, "calendar")}
              className="text-xs text-primary underline-offset-4 hover:underline"
            >
              Voir le calendrier
            </Link>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {vue.upcoming.map((publication) => (
              <li
                key={publication.id}
                className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface p-2.5 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">
                    {PLATFORM_LABELS[publication.platform]} ·{" "}
                    {MEDIA_KIND_LABELS[publication.media_kind]}
                  </span>
                  {publication.caption ? (
                    <span className="block truncate text-xs text-muted">{publication.caption}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {heure(occurrenceOf(publication), timeZone)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {vierge ? (
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
              <ButtonLink href={workspaceHref(slug, "publish")}>Créer une publication</ButtonLink>
            </>
          }
        />
      ) : null}
    </div>
  );
}

function cle(item: AttentionItem): string {
  return item.kind === "account_unusable"
    ? `compte-${item.accountId}`
    : `publication-${item.publicationId}`;
}

/**
 * Une ligne « à traiter » dit TROIS choses : ce qui ne va pas, pourquoi, et où
 * cliquer pour y remédier. Sans le troisième, l'alerte n'est qu'un reproche.
 */
function LigneAttention({
  item,
  slug,
  timeZone,
}: {
  item: AttentionItem;
  slug: string;
  timeZone: string;
}) {
  if (item.kind === "account_unusable") {
    return (
      <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface p-2.5 text-sm">
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground">
            {PLATFORM_LABELS[item.platform as keyof typeof PLATFORM_LABELS] ?? item.platform} ·{" "}
            {item.label}
          </span>
          <span className="block text-xs text-muted">
            Ce compte ne peut plus publier. Reconnectez-le pour reprendre.
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Badge tone="danger">
            {SOCIAL_STATUS_LABELS[item.status as keyof typeof SOCIAL_STATUS_LABELS] ?? item.status}
          </Badge>
          <Link
            href={workspaceHref(slug, "accounts")}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            Reconnecter
          </Link>
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface p-2.5 text-sm">
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-foreground">
          {PLATFORM_LABELS[item.platform as keyof typeof PLATFORM_LABELS] ?? item.platform} —
          publication non parue
        </span>
        <span className="block truncate text-xs text-muted">
          {heure(item.occurredAt, timeZone)}
          {item.caption ? ` · ${item.caption}` : ""}
        </span>
        {item.detail ? (
          <span className="block text-xs text-danger">
            {RAISONS[item.detail] ?? item.detail}
          </span>
        ) : null}
      </span>
      <Link
        href={workspaceHref(slug, "calendar")}
        className="shrink-0 text-xs text-primary underline-offset-2 hover:underline"
      >
        Voir
      </Link>
    </div>
  );
}
