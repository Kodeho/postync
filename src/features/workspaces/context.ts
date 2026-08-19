import { cache } from "react";
import { notFound } from "next/navigation";

import type { WorkspaceMembership } from "@/types/workspace";

import { listMemberships, requireUser } from "./queries";
import { findMembershipBySlug } from "./resolve";

/**
 * Contexte du workspace actif pour une requête.
 *
 * Partagé entre le layout (`/app/[workspaceSlug]/layout.tsx`) et les pages :
 * `cache()` de React mémoïse le résultat pendant un même rendu serveur, donc
 * session, memberships et profil ne sont lus qu'une seule fois par requête.
 *
 * Toutes les informations d'identité (utilisateur, profil, workspaces, rôle)
 * proviennent de la base sous RLS. Aucune valeur n'est inventée côté UI.
 */
export type WorkspaceContext = {
  user: { id: string; email: string | null };
  profile: { displayName: string | null; avatarUrl: string | null };
  memberships: WorkspaceMembership[];
  active: WorkspaceMembership;
};

export const getWorkspaceContext = cache(
  async (slug: string): Promise<WorkspaceContext> => {
    const { supabase, user } = await requireUser();
    const memberships = await listMemberships(supabase, user.id);
    const active = findMembershipBySlug(memberships, slug);

    // Slug mal formé, inconnu ou étranger : même 404, sans rien révéler.
    if (!active) {
      notFound();
    }

    // RLS limite déjà cette lecture au profil de l'utilisateur courant.
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name, avatar_url")
      .eq("id", user.id)
      .maybeSingle();

    const displayName = profile?.display_name?.trim() || null;
    const avatarUrl = profile?.avatar_url?.trim() || null;

    return {
      user: { id: user.id, email: user.email ?? null },
      profile: { displayName, avatarUrl },
      memberships,
      active,
    };
  },
);

/** Nom à afficher : display_name, sinon e-mail, sinon libellé neutre. */
export function userLabel(ctx: WorkspaceContext): string {
  return ctx.profile.displayName ?? ctx.user.email ?? "Utilisateur";
}

/** Prénom (premier mot du nom affiché) pour les salutations. */
export function userFirstName(ctx: WorkspaceContext): string {
  const name = ctx.profile.displayName;
  if (!name) {
    return ctx.user.email ?? "";
  }
  return name.split(/\s+/)[0] ?? name;
}
