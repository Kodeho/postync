import type { Metadata } from "next";
import { connection } from "next/server";
import { Users } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import {
  InvitationRowActions,
  InviteMemberForm,
  MemberRow,
  type TeamInvitation,
  type TeamMember,
} from "@/features/team/team-panels";
import { getWorkspaceContext } from "@/features/workspaces/context";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceAccess } from "@/server/billing/queries";
import { listPendingInvitations, listWorkspaceMembers, seatsUsed } from "@/server/team/queries";

export const metadata: Metadata = {
  title: "Équipe — POSTYNC",
};

/**
 * Équipe du workspace (C14).
 *
 * Les plans Pro et Agency promettent des workspaces multi-membres depuis C6 ;
 * il n'existait pourtant aucun moyen d'inviter qui que ce soit. Ils étaient
 * donc vendus sans être utilisables.
 *
 * L'écran est visible par TOUS les membres — savoir avec qui l'on partage un
 * espace fait partie de l'espace. Seuls owner et admin y agissent.
 */
export default async function TeamPage({ params }: PageProps<"/app/[workspaceSlug]/team">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  const workspace = ctx.active.workspace;
  const role = ctx.active.role;
  const canManage = role === "owner" || role === "admin";

  const supabase = await createClient();
  const [membres, invitations, { access }] = await Promise.all([
    listWorkspaceMembers(supabase, workspace.id),
    listPendingInvitations(supabase, workspace.id),
    getWorkspaceAccess(supabase, workspace.id),
  ]);

  const occupes = seatsUsed(membres, invitations);
  const restants = Math.max(0, access.quotas.members - occupes);

  const membresAffiches: TeamMember[] = membres.map((membre) => ({
    userId: membre.user_id,
    role: membre.role,
    displayName: membre.displayName,
    email: membre.email,
    isSelf: membre.user_id === ctx.user.id,
  }));

  const invitationsAffichees: TeamInvitation[] = invitations.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expires_at,
  }));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Équipe"
        description={`${occupes} siège(s) occupé(s) sur ${access.quotas.members} (plan ${access.plan.name}), invitations en attente comprises.`}
      />

      {canManage ? (
        <Panel as="section" aria-labelledby="team-invite" className="p-6">
          <h2 id="team-invite" className="text-base font-semibold text-foreground">
            Inviter quelqu&apos;un
          </h2>
          <InviteMemberForm
            workspaceSlug={workspace.slug}
            canInviteAdmins={role === "owner"}
            seatsLeft={restants}
          />
        </Panel>
      ) : null}

      <Panel as="section" aria-labelledby="team-members" className="p-6">
        <h2 id="team-members" className="text-base font-semibold text-foreground">
          Membres
        </h2>
        <ul className="mt-4 flex flex-col gap-2">
          {membresAffiches.map((membre) => (
            <MemberRow
              key={membre.userId}
              workspaceSlug={workspace.slug}
              member={membre}
              actorRole={role}
            />
          ))}
        </ul>
      </Panel>

      {invitationsAffichees.length > 0 ? (
        <Panel as="section" aria-labelledby="team-invitations" className="p-6">
          <h2 id="team-invitations" className="text-base font-semibold text-foreground">
            Invitations en attente
          </h2>
          <ul className="mt-4 flex flex-col gap-2">
            {invitationsAffichees.map((invitation) => (
              // Clé sur l'ADRESSE, pas sur l'identifiant. Renvoyer une
              // invitation en crée une nouvelle : la clé changerait, React
              // démonterait la ligne, et le lien tout juste émis disparaîtrait
              // avant d'avoir été lu. L'index unique partiel garantit au plus
              // une invitation vivante par adresse, l'adresse est donc une
              // identité stable — et c'est aussi ainsi que l'utilisateur voit
              // la chose : « l'invitation de X », dont le lien est réémis.
              <InvitationRowActions
                key={invitation.email}
                workspaceSlug={workspace.slug}
                invitation={invitation}
              />
            ))}
          </ul>
        </Panel>
      ) : canManage ? (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title="Aucune invitation en attente."
          description="Invitez quelqu'un par son adresse e-mail : lui seul pourra accepter le lien."
        />
      ) : null}
    </div>
  );
}
