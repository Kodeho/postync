import type { Metadata } from "next";
import { connection } from "next/server";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { getWorkspaceContext } from "@/features/workspaces/context";
import type { SocialPlatform } from "@/types/platform";

export const metadata: Metadata = {
  title: "Comptes sociaux — POSTYNC",
};

export default async function AccountsPage({
  params,
}: PageProps<"/app/[workspaceSlug]/accounts">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  void ctx;

  const platforms: { key: SocialPlatform; label: string; abbr: string }[] = [
    { key: "instagram", label: "Instagram", abbr: "Ig" },
    { key: "facebook", label: "Facebook", abbr: "Fb" },
    { key: "tiktok", label: "TikTok", abbr: "Tt" },
    { key: "youtube", label: "YouTube", abbr: "Yt" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Comptes sociaux"
        description="Connectez les réseaux sur lesquels ce workspace publie."
      />

      <ul className="grid gap-4 sm:grid-cols-2" aria-label="Plateformes">
        {platforms.map((platform) => (
          <li key={platform.key}>
            <Panel className="flex items-center gap-4 p-5">
              <span
                aria-hidden="true"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-muted text-sm font-semibold text-muted"
              >
                {platform.abbr}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{platform.label}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-muted-soft" />
                  Non connecté
                </p>
              </div>
              <Button variant="secondary" size="sm" disabled title="La connexion arrive bientôt">
                Connecter
              </Button>
            </Panel>
          </li>
        ))}
      </ul>

      <p className="text-sm text-muted">
        La connexion des comptes sera disponible dans une prochaine étape.
      </p>
    </div>
  );
}
