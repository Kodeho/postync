"use server";

import { revalidatePath } from "next/cache";

import { isKnownTimeZone } from "@/lib/time-zone";
import { findMembershipBySlug } from "@/features/workspaces/resolve";
import { listMemberships, requireUser } from "@/features/workspaces/queries";
import { validateWorkspaceName } from "@/features/workspaces/validation";
import type { WorkspaceMembership } from "@/types/workspace";

import type { SettingsFormState } from "./state";

/**
 * Réglages du workspace et du profil (C13).
 *
 * Jusqu'ici l'écran Paramètres était en LECTURE SEULE : un client ne pouvait
 * ni corriger une faute dans le nom de son workspace, ni changer son nom
 * affiché. La base l'autorisait pourtant déjà — seules l'interface et les
 * actions manquaient.
 *
 * SÉCURITÉ. Ces actions n'utilisent PAS le client service_role : elles
 * écrivent sous la session de l'utilisateur, et laissent donc RLS et les
 * privilèges de colonnes trancher. C'est volontaire — la base a déjà la bonne
 * réponse :
 *
 *   * `workspaces_update_owner_admin` limite l'écriture aux owner et admin ;
 *   * `authenticated` n'a le droit d'UPDATE que sur `name` et `time_zone` :
 *     ni `slug` (les URL et les redirect_uri OAuth ne bougent pas), ni
 *     `owner_id` (personne ne s'approprie un workspace) ;
 *   * `profiles_update_own` limite chacun à son propre profil.
 *
 * Le contrôle applicatif du rôle vient EN PLUS, pour donner un message utile
 * plutôt qu'un refus silencieux de la base.
 */

const ROLE_REFUSE =
  "Seul le propriétaire ou un admin du workspace peut modifier ces réglages.";

async function requireWorkspaceManager(
  formData: FormData,
): Promise<{ ok: true; membership: WorkspaceMembership } | { ok: false; error: string }> {
  const slug = String(formData.get("workspaceSlug") ?? "");
  const { supabase, user } = await requireUser();
  const memberships = await listMemberships(supabase, user.id);
  const membership = findMembershipBySlug(memberships, slug);
  if (!membership) {
    return { ok: false, error: "Workspace introuvable." };
  }
  if (membership.role !== "owner" && membership.role !== "admin") {
    return { ok: false, error: ROLE_REFUSE };
  }
  return { ok: true, membership };
}

/** Renomme le workspace. Le slug, lui, ne bouge pas : les URL restent valides. */
export async function renameWorkspaceAction(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const auth = await requireWorkspaceManager(formData);
  if (!auth.ok) {
    return { error: auth.error, notice: null };
  }

  // La même validation qu'à la création : un nom valide à la création doit
  // rester valide à la modification.
  const validation = validateWorkspaceName(formData);
  if (!validation.ok) {
    return { error: validation.error, notice: null };
  }

  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("workspaces")
    .update({ name: validation.value })
    .eq("id", auth.membership.workspace.id);

  if (error) {
    console.error(`[settings:rename] ${error.code ?? "inconnu"}`);
    return { error: "Le nom n'a pas pu être enregistré. Réessayez.", notice: null };
  }

  revalidatePath(`/app/${auth.membership.workspace.slug}`, "layout");
  return { error: null, notice: "Nom du workspace enregistré." };
}

/**
 * Change le fuseau horaire du workspace.
 *
 * Il ne s'agit pas d'un confort : c'est la référence commune du calendrier, de
 * la vue d'ensemble ET de la saisie des échéances. Une valeur fantaisiste
 * produirait un décalage silencieux, d'où la double validation — ici, puis par
 * le trigger de la base, qui la confronte à la liste réelle des fuseaux.
 */
export async function updateTimeZoneAction(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const auth = await requireWorkspaceManager(formData);
  if (!auth.ok) {
    return { error: auth.error, notice: null };
  }

  const timeZone = String(formData.get("timeZone") ?? "").trim();
  if (!isKnownTimeZone(timeZone)) {
    return { error: "Fuseau horaire inconnu.", notice: null };
  }

  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("workspaces")
    .update({ time_zone: timeZone })
    .eq("id", auth.membership.workspace.id);

  if (error) {
    console.error(`[settings:time-zone] ${error.code ?? "inconnu"}`);
    return { error: "Le fuseau horaire n'a pas pu être enregistré. Réessayez.", notice: null };
  }

  // Le fuseau change ce que TOUTES les pages affichent.
  revalidatePath(`/app/${auth.membership.workspace.slug}`, "layout");
  return {
    error: null,
    notice: `Fuseau horaire enregistré : ${timeZone}. Les heures affichées et les échéances s'y réfèrent désormais.`,
  };
}

/**
 * Change le nom affiché du profil.
 *
 * Aucun contrôle de rôle : chacun modifie SON profil, et `profiles_update_own`
 * l'y limite. Un membre simple a le droit de corriger son propre nom.
 */
export async function updateDisplayNameAction(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const { supabase, user } = await requireUser();

  const nom = String(formData.get("displayName") ?? "").trim();
  if (nom.length === 0) {
    return { error: "Le nom affiché ne peut pas être vide.", notice: null };
  }
  if (nom.length > 80) {
    return { error: "Le nom affiché ne doit pas dépasser 80 caractères.", notice: null };
  }

  const { error } = await supabase
    .from("profiles")
    .update({ display_name: nom })
    .eq("id", user.id);

  if (error) {
    console.error(`[settings:display-name] ${error.code ?? "inconnu"}`);
    return { error: "Le nom affiché n'a pas pu être enregistré. Réessayez.", notice: null };
  }

  revalidatePath("/app", "layout");
  return { error: null, notice: "Nom affiché enregistré." };
}
