import type { Metadata } from "next";
import { connection } from "next/server";

import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import {
  DisplayNameForm,
  RenameWorkspaceForm,
  TimeZoneForm,
} from "@/features/settings/settings-forms";
import { WORKSPACE_ROLE_LABELS } from "@/features/workspaces/display";
import { getWorkspaceContext } from "@/features/workspaces/context";

export const metadata: Metadata = {
  title: "Paramètres — POSTYNC",
};

/**
 * Réglages du workspace et du profil (C13).
 *
 * L'écran était en LECTURE SEULE : un client ne pouvait pas corriger une faute
 * dans le nom de son workspace, ni changer son nom affiché. La base
 * l'autorisait déjà — seule l'interface manquait.
 *
 * Le fuseau horaire n'est pas un confort : il était codé en dur dans deux
 * pages tandis que la saisie d'échéance convertissait depuis le fuseau du
 * NAVIGATEUR. Un client hors de France programmait donc à une heure et la
 * voyait affichée à une autre.
 */
export default async function SettingsPage({
  params,
}: PageProps<"/app/[workspaceSlug]/settings">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  const { active, profile, user } = ctx;
  const canManage = active.role === "owner" || active.role === "admin";

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Paramètres"
        description="Workspace, profil et préférences."
      />

      <div className="flex flex-col gap-6">
        <Panel as="section" aria-labelledby="settings-workspace" id="workspace" className="p-6">
          <h2 id="settings-workspace" className="text-base font-semibold text-foreground">
            Workspace
          </h2>

          {canManage ? (
            <RenameWorkspaceForm
              workspaceSlug={active.workspace.slug}
              currentName={active.workspace.name}
            />
          ) : (
            <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
              <dt className="text-muted">Nom</dt>
              <dd className="font-medium text-foreground">{active.workspace.name}</dd>
            </dl>
          )}

          <dl className="mt-4 grid gap-x-8 gap-y-3 border-t border-border pt-4 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-muted">Adresse</dt>
            <dd className="font-mono text-xs text-foreground">/app/{active.workspace.slug}</dd>
            <dt className="text-muted">Votre rôle</dt>
            <dd className="font-medium text-foreground">{WORKSPACE_ROLE_LABELS[active.role]}</dd>
          </dl>

          {!canManage ? (
            <p className="mt-4 text-xs text-muted">
              Seul le propriétaire ou un admin peut modifier ces réglages.
            </p>
          ) : null}
        </Panel>

        <Panel as="section" aria-labelledby="settings-time-zone" id="fuseau" className="p-6">
          <h2 id="settings-time-zone" className="text-base font-semibold text-foreground">
            Fuseau horaire
          </h2>
          {canManage ? (
            <TimeZoneForm
              workspaceSlug={active.workspace.slug}
              currentTimeZone={active.workspace.time_zone}
            />
          ) : (
            <p className="mt-4 text-sm text-foreground">
              {active.workspace.time_zone.replace(/_/g, " ")}
            </p>
          )}
        </Panel>

        <Panel as="section" aria-labelledby="settings-profile" id="profil" className="p-6">
          <h2 id="settings-profile" className="text-base font-semibold text-foreground">
            Profil
          </h2>
          <DisplayNameForm currentName={profile.displayName} />
          <dl className="mt-4 grid gap-x-8 gap-y-3 border-t border-border pt-4 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-muted">Adresse e-mail</dt>
            <dd className="font-medium text-foreground">{user.email ?? "—"}</dd>
          </dl>
        </Panel>
      </div>
    </div>
  );
}
