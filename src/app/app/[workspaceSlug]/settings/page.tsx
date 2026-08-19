import type { Metadata } from "next";
import { connection } from "next/server";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { WORKSPACE_ROLE_LABELS } from "@/features/workspaces/display";
import { getWorkspaceContext } from "@/features/workspaces/context";

export const metadata: Metadata = {
  title: "Paramètres — POSTYNC",
};

export default async function SettingsPage({
  params,
}: PageProps<"/app/[workspaceSlug]/settings">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  const { active, profile, user } = ctx;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Paramètres"
        description="Workspace, profil et préférences. Les réglages avancés arriveront progressivement."
      />

      <div className="flex flex-col gap-6">
        <Panel as="section" aria-labelledby="settings-workspace" id="workspace" className="p-6">
          <h2 id="settings-workspace" className="text-base font-semibold text-foreground">
            Workspace
          </h2>
          <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-muted">Nom</dt>
            <dd className="font-medium text-foreground">{active.workspace.name}</dd>
            <dt className="text-muted">Adresse</dt>
            <dd className="font-mono text-xs text-foreground">/app/{active.workspace.slug}</dd>
            <dt className="text-muted">Votre rôle</dt>
            <dd className="font-medium text-foreground">{WORKSPACE_ROLE_LABELS[active.role]}</dd>
          </dl>
        </Panel>

        <Panel as="section" aria-labelledby="settings-profile" id="profil" className="p-6">
          <h2 id="settings-profile" className="text-base font-semibold text-foreground">
            Profil
          </h2>
          <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-muted">Nom affiché</dt>
            <dd className="font-medium text-foreground">{profile.displayName ?? "—"}</dd>
            <dt className="text-muted">Adresse e-mail</dt>
            <dd className="font-medium text-foreground">{user.email ?? "—"}</dd>
          </dl>
        </Panel>

        <Panel as="section" aria-labelledby="settings-preferences" id="preferences" className="p-6">
          <h2 id="settings-preferences" className="text-base font-semibold text-foreground">
            Préférences
          </h2>
          <p className="mt-2 text-sm text-muted">
            Langue, fuseau horaire et notifications arriveront dans une prochaine étape.
          </p>
        </Panel>
      </div>
    </div>
  );
}
