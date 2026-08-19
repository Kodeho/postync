import type { Metadata } from "next";
import { connection } from "next/server";

import { Badge } from "@/components/admin/badges";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { requirePlatformRole } from "@/server/admin/authorization";
import { getEnvironmentLabel, getIntegrationStatuses } from "@/server/admin/platform-status";

import packageJson from "../../../../package.json";

export const metadata: Metadata = {
  title: "Plateforme — POSTYNC Admin",
};

/** État des intégrations : présence des variables seulement, jamais leurs valeurs. */
export default async function AdminPlatformPage() {
  await connection();
  await requirePlatformRole();

  const integrations = getIntegrationStatuses();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Plateforme"
        description="Environnement et état des intégrations. Aucune clé ni aucun secret n'est affiché."
      />

      <Panel as="section" aria-labelledby="platform-env" className="p-6">
        <h2 id="platform-env" className="text-base font-semibold text-foreground">
          Application
        </h2>
        <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
          <dt className="text-muted">Environnement</dt>
          <dd className="font-mono text-xs text-foreground">{getEnvironmentLabel()}</dd>
          <dt className="text-muted">Version POSTYNC</dt>
          <dd className="font-mono text-xs text-foreground">{packageJson.version}</dd>
        </dl>
      </Panel>

      <Panel as="section" aria-labelledby="platform-integrations" className="overflow-hidden">
        <h2 id="platform-integrations" className="border-b border-border px-6 py-4 text-base font-semibold text-foreground">
          Intégrations
        </h2>
        <ul className="divide-y divide-border">
          {integrations.map((item) => (
            <li key={item.key} className="flex items-center gap-4 px-6 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{item.label}</p>
                <p className="text-xs text-muted">{item.note}</p>
              </div>
              <Badge tone={item.configured ? "success" : "neutral"}>
                {item.configured ? "Configuré" : "Non configuré"}
              </Badge>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
