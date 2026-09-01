import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AuthShell } from "@/components/layout/auth-shell";
import { CreateWorkspaceForm } from "@/features/workspaces/create-workspace-form";
import { listMemberships, requireUser } from "@/features/workspaces/queries";
import { requireLegalAcceptance } from "@/server/legal/guard";

export const metadata: Metadata = {
  title: "Bienvenue — POSTYNC",
};

/**
 * Onboarding minimal : création du premier workspace.
 *
 * Réservé aux utilisateurs connectés SANS workspace. Un utilisateur qui en
 * possède déjà est renvoyé vers `/app` (qui résout son workspace actif).
 */
export default async function OnboardingPage() {
  await connection();

  const { supabase, user } = await requireUser();

  // Créer un workspace est déjà une fonctionnalité de l'application : la
  // garde s'applique avant, pas après.
  await requireLegalAcceptance(supabase, user.id);

  const memberships = await listMemberships(supabase, user.id);

  if (memberships.length > 0) {
    redirect("/app");
  }

  return (
    <AuthShell title="Bienvenue dans POSTYNC">
      <p className="mb-6 text-sm text-muted">
        Créez votre premier espace de travail.
      </p>
      <CreateWorkspaceForm
        submitLabel="Créer mon espace"
        pendingLabel="Création…"
      />
    </AuthShell>
  );
}
