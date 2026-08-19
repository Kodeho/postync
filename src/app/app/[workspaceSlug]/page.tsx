import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { PRODUCT_NAME } from "@/config/product";
import { signOutAction } from "@/features/auth/actions";
import { CreateWorkspaceForm } from "@/features/workspaces/create-workspace-form";
import { listMemberships, requireUser } from "@/features/workspaces/queries";
import { findMembershipBySlug } from "@/features/workspaces/resolve";
import type { WorkspaceRole } from "@/types/workspace-role";

export const metadata: Metadata = {
  title: "Mon espace — POSTYNC",
};

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/**
 * `/app/[workspaceSlug]` — espace privé minimal, conscient du workspace.
 *
 * Le slug d'URL n'est PAS une autorisation. Il est confronté aux memberships
 * réels de l'utilisateur (lus sous RLS) : un slug inconnu, mal formé, ou
 * appartenant à un workspace dont l'utilisateur n'est pas membre aboutit au
 * même 404, sans révéler l'existence du workspace.
 */
export default async function WorkspacePage({
  params,
}: PageProps<"/app/[workspaceSlug]">) {
  await connection();

  const { workspaceSlug } = await params;
  const { supabase, user } = await requireUser();

  const memberships = await listMemberships(supabase, user.id);
  const active = findMembershipBySlug(memberships, workspaceSlug);

  if (!active) {
    notFound();
  }

  // RLS restreint déjà cette lecture au profil de l'utilisateur courant.
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();

  const displayName = profile?.display_name?.trim();
  const label = displayName && displayName.length > 0 ? displayName : user.email;
  const others = memberships.filter(
    (m) => m.workspace.id !== active.workspace.id,
  );

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">{PRODUCT_NAME}</h1>

      <section className="flex flex-col gap-1">
        <p className="text-sm opacity-70">Workspace actif :</p>
        <p className="text-xl font-medium">{active.workspace.name}</p>
      </section>

      <p className="text-lg">Bienvenue, {label}</p>

      <section className="flex flex-col gap-1">
        <p className="text-sm opacity-70">Rôle :</p>
        <p className="font-medium">{ROLE_LABELS[active.role]}</p>
      </section>

      {others.length > 0 ? (
        <nav aria-label="Autres workspaces" className="flex flex-col gap-2">
          <p className="text-sm opacity-70">Changer de workspace :</p>
          <ul className="flex flex-wrap justify-center gap-3 text-sm">
            {others.map((m) => (
              <li key={m.workspace.id}>
                <Link
                  href={`/app/${m.workspace.slug}`}
                  className="underline underline-offset-4"
                >
                  {m.workspace.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <details className="w-full max-w-sm text-left">
        <summary className="cursor-pointer text-sm underline underline-offset-4">
          Créer un autre workspace
        </summary>
        <div className="mt-4">
          <CreateWorkspaceForm
            submitLabel="Créer le workspace"
            pendingLabel="Création…"
          />
        </div>
      </details>

      <form action={signOutAction}>
        <button
          type="submit"
          className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80 dark:border-white/20"
        >
          Se déconnecter
        </button>
      </form>
    </main>
  );
}
