"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { isSupabaseConfigured } from "@/lib/supabase/env";
import type { Workspace } from "@/types/workspace";

import { requireUser } from "./queries";
import type { WorkspaceFormState } from "./state";
import { validateWorkspaceName } from "./validation";

const GENERIC_ERROR =
  "Impossible de créer le workspace pour le moment. Veuillez réessayer.";

function failure(error: string, name: string): WorkspaceFormState {
  return { error, name };
}

/**
 * Création d'un workspace.
 *
 * Délègue entièrement à la RPC PostgreSQL `create_workspace(p_name)` :
 * - `security definer`, `search_path = ''` ;
 * - le propriétaire est TOUJOURS `auth.uid()` côté base, jamais un
 *   identifiant fourni par le navigateur ;
 * - INSERT workspaces + INSERT workspace_members(owner) sont atomiques ;
 * - le slug est calculé et dédoublonné côté base (contrainte unique).
 *
 * Aucune limite d'abonnement n'est appliquée en C4 : le module billing
 * décidera plus tard `CanCreateWorkspace?` avant cet appel.
 */
export async function createWorkspaceAction(
  _prevState: WorkspaceFormState,
  formData: FormData,
): Promise<WorkspaceFormState> {
  const rawName = String(formData.get("name") ?? "").trim();

  if (!isSupabaseConfigured()) {
    return failure(
      "L'application n'est pas encore configurée sur cette installation.",
      rawName,
    );
  }

  const parsed = validateWorkspaceName(formData);
  if (!parsed.ok) {
    return failure(parsed.error, rawName);
  }

  // Contrôle d'accès faisant autorité : session valide ET compte actif
  // (un compte suspendu est redirigé). La RPC refuse de toute façon un appel
  // sans `auth.uid()` ou avec un compte suspendu.
  const { supabase } = await requireUser();

  let slug: string;

  try {
    // Sans types générés pour la base, `data` est `unknown` : la RPC renvoie
    // la ligne `workspaces` créée (composite, donc un objet et non un tableau).
    const { data, error } = await supabase.rpc("create_workspace", {
      p_name: parsed.value,
    });
    const workspace = (data ?? null) as Workspace | null;

    if (error || !workspace) {
      console.error(
        `[workspaces:create] ${error?.code ?? "no-data"}: ${error?.message ?? ""}`,
      );
      return failure(GENERIC_ERROR, rawName);
    }

    slug = workspace.slug;
  } catch (error) {
    console.error(
      `[workspaces:create] ${error instanceof Error ? error.message : "erreur non typée"}`,
    );
    return failure(GENERIC_ERROR, rawName);
  }

  revalidatePath("/app", "layout");
  redirect(`/app/${slug}`);
}
