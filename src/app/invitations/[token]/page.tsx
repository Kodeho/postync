import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AuthShell } from "@/components/layout/auth-shell";
import { FormAlert } from "@/components/ui/form-alert";
import { AcceptInvitationForm } from "@/features/team/accept-form";
import { createClient } from "@/lib/supabase/server";
import { hashInvitationToken } from "@/server/team/invitations";
import { createServiceClient } from "@/server/supabase/service-client";
import { PRODUCT_NAME } from "@/config/product";

export const metadata: Metadata = {
  title: `Rejoindre un workspace — ${PRODUCT_NAME}`,
  robots: { index: false, follow: false },
};

/**
 * Page d'acceptation d'une invitation (C14).
 *
 * TROIS PRINCIPES.
 *
 * 1. LE JETON NE SERT QU'À DÉSIGNER L'INVITATION, jamais à autoriser. Il est
 *    haché ici et comparé à l'empreinte stockée ; l'autorisation réelle vient
 *    de la comparaison entre l'adresse du compte connecté et celle de
 *    l'invitation, faite en base par `accept_workspace_invitation`. Un lien
 *    transmis par erreur à un tiers ne lui ouvre donc rien.
 *
 * 2. RIEN N'EST ACCEPTÉ AUTOMATIQUEMENT. Un simple chargement de page — un
 *    aperçu de lien dans une messagerie, un préchargement de navigateur —
 *    ne doit pas faire rejoindre un workspace. L'acceptation demande un geste
 *    explicite.
 *
 * 3. LA PAGE NE DIT RIEN À QUI N'EST PAS CONCERNÉ. Elle affiche le nom du
 *    workspace et l'adresse invitée uniquement à l'utilisateur connecté avec
 *    cette adresse ; sinon elle explique quoi faire, sans divulguer.
 */
/** Instant de rendu, lu une seule fois. */
function instantDeRendu(): number {
  return Date.now();
}

export default async function InvitationPage({
  params,
}: PageProps<"/invitations/[token]">) {
  await connection();

  const { token } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Sans session, on renvoie vers la connexion en conservant la destination :
  // la personne revient ici une fois identifiée, sans reperdre son lien.
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/invitations/${token}`)}`);
  }

  // Lecture par le service : la table n'est pas lisible par une session qui
  // n'appartient pas encore au workspace — ce qui est précisément le cas ici.
  const db = createServiceClient();
  const { data: invitation } = await db
    .from("workspace_invitations")
    .select("id, email, role, expires_at, accepted_at, revoked_at, workspace:workspaces(name)")
    .eq("token_hash", hashInvitationToken(token))
    .maybeSingle<{
      id: string;
      email: string;
      role: string;
      expires_at: string;
      accepted_at: string | null;
      revoked_at: string | null;
      workspace: { name: string } | null;
    }>();

  const emailConnecte = (user.email ?? "").toLowerCase();
  const maintenant = instantDeRendu();

  let probleme: string | null = null;
  if (!invitation) {
    probleme = "Ce lien d'invitation n'est pas valide.";
  } else if (invitation.revoked_at) {
    probleme = "Cette invitation a été annulée.";
  } else if (invitation.accepted_at) {
    probleme = "Cette invitation a déjà été utilisée.";
  } else if (new Date(invitation.expires_at).getTime() <= maintenant) {
    probleme = "Cette invitation a expiré. Demandez-en une nouvelle.";
  } else if (invitation.email !== emailConnecte) {
    // On ne révèle NI le workspace NI l'adresse invitée : cette page est
    // atteignable par quiconque possède le lien.
    probleme =
      "Cette invitation a été adressée à une autre adresse e-mail. Connectez-vous avec le compte concerné, ou demandez une nouvelle invitation.";
  }

  return (
    <AuthShell title="Rejoindre un workspace">
      {probleme ? (
        <div className="flex flex-col gap-4">
          <FormAlert tone="error">{probleme}</FormAlert>
          <p className="text-sm text-muted">
            <Link href="/app" className="font-medium text-primary underline-offset-4 hover:underline">
              Retour à POSTYNC
            </Link>
          </p>
        </div>
      ) : (
        <AcceptInvitationForm
          token={token}
          workspaceName={invitation!.workspace?.name ?? "ce workspace"}
          role={invitation!.role}
          email={invitation!.email}
        />
      )}
    </AuthShell>
  );
}
