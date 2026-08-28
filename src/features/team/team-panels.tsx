"use client";

import { useActionState } from "react";

import { Badge } from "@/components/admin/badges";
import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { TextField } from "@/components/ui/text-field";
import { WORKSPACE_ROLE_LABELS, avatarToneClass, initials } from "@/features/workspaces/display";
import type { WorkspaceRole } from "@/types/workspace-role";

import {
  inviteMemberAction,
  leaveWorkspaceAction,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
  setMemberRoleAction,
} from "./actions";
import { IDLE_TEAM_ACTION } from "./state";

/**
 * Écrans d'équipe (C14).
 *
 * Chaque action a son propre formulaire et son propre état : retirer un membre
 * ne doit pas effacer le message de l'invitation qu'on vient d'émettre, ni
 * l'inverse.
 *
 * ATTENTION AUX CLÉS. L'état d'un formulaire ne survit que tant que le
 * composant reste monté. Renvoyer une invitation en crée une NOUVELLE ligne :
 * une clé fondée sur l'identifiant démonterait la ligne au rafraîchissement et
 * emporterait le lien tout juste émis — que rien ne permettrait plus de
 * retrouver, l'ancien étant révoqué et le jeton n'étant pas conservé. Les
 * lignes d'invitation sont donc identifiées par leur adresse.
 *
 * Ce qui n'est PAS permis n'est pas affiché grisé sans explication : soit le
 * contrôle disparaît (un admin ne voit pas de bouton sur un propriétaire),
 * soit la raison est donnée par le serveur.
 */

export type TeamMember = {
  userId: string;
  role: WorkspaceRole;
  displayName: string | null;
  email: string | null;
  isSelf: boolean;
};

export type TeamInvitation = {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
};

/**
 * Lien d'invitation, affiché une seule fois — le jeton n'est pas conservé.
 *
 * N'est rendu que tant que l'invitation qu'il ouvre est VIVANTE : l'annuler ou
 * la renvoyer le rend inutilisable, et continuer de l'afficher sous « copiez-le
 * maintenant » inviterait à transmettre un lien mort.
 */
function LienInvitation({ url }: { url: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-success/30 bg-success-soft p-3">
      <p className="text-xs font-medium text-success">
        Lien d&apos;invitation — copiez-le maintenant, il ne sera plus affiché.
      </p>
      <code className="break-all rounded bg-surface px-2 py-1 font-mono text-xs text-foreground">
        {url}
      </code>
    </div>
  );
}

export function InviteMemberForm({
  workspaceSlug,
  canInviteAdmins,
  seatsLeft,
  liveInvitationIds,
}: {
  workspaceSlug: string;
  /** Un admin ne peut inviter que des membres. */
  canInviteAdmins: boolean;
  seatsLeft: number;
  /** Invitations encore en attente, pour ne pas afficher un lien périmé. */
  liveInvitationIds: readonly string[];
}) {
  const [state, action] = useActionState(inviteMemberAction, IDLE_TEAM_ACTION);

  if (seatsLeft <= 0) {
    return (
      <p className="mt-4 text-sm text-muted">
        Tous les sièges de votre plan sont occupés, invitations en attente comprises. Retirez un
        membre, annulez une invitation, ou passez à un plan supérieur.
      </p>
    );
  }

  return (
    <form action={action} className="mt-4 flex flex-col gap-3">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <TextField
            label="Adresse e-mail"
            name="email"
            type="email"
            required
            placeholder="collegue@exemple.com"
            hint="Seule cette adresse pourra accepter l'invitation."
          />
        </div>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Rôle</span>
          <select
            name="role"
            defaultValue="member"
            className="rounded-md border border-border bg-surface px-3 py-2 text-foreground shadow-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
          >
            <option value="member">Member — publie et consulte</option>
            {canInviteAdmins ? (
              <option value="admin">Admin — gère aussi les comptes et l&apos;équipe</option>
            ) : null}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-3">
        <SubmitButton label="Inviter" pendingLabel="Création…" />
        <span className="text-xs text-muted">{seatsLeft} siège(s) disponible(s)</span>
      </div>
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
      {/* Le message et le lien vont ensemble : « transmettez ce lien » sans
          lien ne veut rien dire. Ils disparaissent donc du même coup lorsque
          l'invitation cesse d'être en attente. */}
      {state.notice && state.invitationId && liveInvitationIds.includes(state.invitationId) ? (
        <>
          <FormAlert tone="notice">{state.notice}</FormAlert>
          {state.invitationUrl ? <LienInvitation url={state.invitationUrl} /> : null}
        </>
      ) : null}
    </form>
  );
}

export function MemberRow({
  workspaceSlug,
  member,
  actorRole,
}: {
  workspaceSlug: string;
  member: TeamMember;
  actorRole: WorkspaceRole;
}) {
  const [roleState, roleAction] = useActionState(setMemberRoleAction, IDLE_TEAM_ACTION);
  const [removeState, removeAction] = useActionState(removeMemberAction, IDLE_TEAM_ACTION);

  // Trois exclusions : le propriétaire, dont le rôle est immuable tant qu'il
  // est propriétaire ; soi-même, pour ne pas se retirer par inadvertance ; et,
  // pour un admin, tout ce qui n'est pas un simple membre.
  const peutAgir =
    !member.isSelf &&
    member.role !== "owner" &&
    (actorRole === "owner" || (actorRole === "admin" && member.role === "member"));

  const libelle = member.displayName ?? member.email ?? "Membre";

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-3">
      <span
        aria-hidden="true"
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${avatarToneClass(member.userId)}`}
      >
        {initials(libelle)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {libelle}
          {member.isSelf ? <span className="ml-1 text-xs text-muted">(vous)</span> : null}
        </span>
        {member.email ? (
          <span className="block truncate text-xs text-muted">{member.email}</span>
        ) : null}
      </span>

      {peutAgir ? (
        <form action={roleAction} className="flex items-center gap-2">
          <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
          <input type="hidden" name="userId" value={member.userId} />
          <select
            name="role"
            defaultValue={member.role}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            {/* `owner` n'est pas proposé : un workspace n'a qu'un propriétaire,
                et le transfert de propriété n'appartient pas à cet écran. */}
          </select>
          <SubmitButton label="Changer" pendingLabel="…" />
        </form>
      ) : (
        <Badge tone={member.role === "owner" ? "primary" : "neutral"}>
          {WORKSPACE_ROLE_LABELS[member.role]}
        </Badge>
      )}

      {peutAgir ? (
        <form action={removeAction}>
          <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
          <input type="hidden" name="userId" value={member.userId} />
          <button
            type="submit"
            className="text-xs text-muted underline-offset-2 hover:text-danger hover:underline"
          >
            Retirer
          </button>
        </form>
      ) : null}

      {roleState.notice ? (
        <span className="w-full">
          <FormAlert tone="notice">{roleState.notice}</FormAlert>
        </span>
      ) : null}
      {roleState.error ? (
        <span className="w-full">
          <FormAlert tone="error">{roleState.error}</FormAlert>
        </span>
      ) : null}
      {removeState.error ? (
        <span className="w-full">
          <FormAlert tone="error">{removeState.error}</FormAlert>
        </span>
      ) : null}
    </li>
  );
}

export function InvitationRowActions({
  workspaceSlug,
  invitation,
  liveInvitationIds,
}: {
  workspaceSlug: string;
  invitation: TeamInvitation;
  liveInvitationIds: readonly string[];
}) {
  const [resendState, resendAction] = useActionState(resendInvitationAction, IDLE_TEAM_ACTION);
  const [revokeState, revokeAction] = useActionState(revokeInvitationAction, IDLE_TEAM_ACTION);

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-3">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {invitation.email}
        </span>
        <span className="block text-xs text-muted">
          {WORKSPACE_ROLE_LABELS[invitation.role as WorkspaceRole] ?? invitation.role} · expire le{" "}
          {new Date(invitation.expiresAt).toLocaleDateString("fr-FR", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </span>
      </span>

      <form action={resendAction}>
        <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
        <input type="hidden" name="invitationId" value={invitation.id} />
        <button
          type="submit"
          className="text-xs text-primary underline-offset-2 hover:underline"
        >
          Renvoyer
        </button>
      </form>

      <form action={revokeAction}>
        <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
        <input type="hidden" name="invitationId" value={invitation.id} />
        <button
          type="submit"
          className="text-xs text-muted underline-offset-2 hover:text-danger hover:underline"
        >
          Annuler
        </button>
      </form>

      {resendState.notice &&
      resendState.invitationId &&
      liveInvitationIds.includes(resendState.invitationId) ? (
        <span className="flex w-full flex-col gap-2">
          <FormAlert tone="notice">{resendState.notice}</FormAlert>
          {resendState.invitationUrl ? <LienInvitation url={resendState.invitationUrl} /> : null}
        </span>
      ) : null}
      {resendState.error ? (
        <span className="w-full">
          <FormAlert tone="error">{resendState.error}</FormAlert>
        </span>
      ) : null}
      {revokeState.error ? (
        <span className="w-full">
          <FormAlert tone="error">{revokeState.error}</FormAlert>
        </span>
      ) : null}
    </li>
  );
}

/**
 * Quitter un workspace.
 *
 * DÉLIBÉRÉMENT EN DEUX TEMPS. Partir n'est pas réversible d'un clic : il
 * faudra qu'un owner ou un admin réinvite la personne, et ce n'est pas en son
 * pouvoir. Un `confirm()` de navigateur ferait le même office, mais bloquerait
 * la page ; le repli sur un dépliant natif demande le même geste conscient et
 * laisse en plus la place d'EXPLIQUER la conséquence, ce qu'une boîte de
 * dialogue fait mal.
 */
export function LeaveWorkspaceForm({
  workspaceSlug,
  workspaceName,
  isOwner,
}: {
  workspaceSlug: string;
  workspaceName: string;
  isOwner: boolean;
}) {
  const [state, action] = useActionState(leaveWorkspaceAction, IDLE_TEAM_ACTION);

  if (isOwner) {
    return (
      <p className="mt-2 text-sm text-muted">
        Vous êtes propriétaire de « {workspaceName} » : vous ne pouvez pas le quitter,
        sans quoi plus personne ne pourrait l&apos;administrer.
      </p>
    );
  }

  return (
    <details className="mt-2 group">
      <summary className="cursor-pointer list-none text-sm text-muted underline-offset-2 hover:text-danger hover:underline">
        Quitter « {workspaceName} »
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-sm text-muted">
          Vous perdrez immédiatement l&apos;accès aux comptes sociaux, aux médias et aux
          publications de ce workspace. Pour y revenir, il faudra qu&apos;un propriétaire
          ou un admin vous réinvite.
        </p>
        {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
        <form action={action}>
          <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
          <button
            type="submit"
            className="inline-flex h-10 items-center justify-center rounded-md border border-danger/40 bg-danger-soft px-4 text-sm font-medium text-danger transition-colors hover:bg-danger hover:text-white"
          >
            Confirmer et quitter
          </button>
        </form>
      </div>
    </details>
  );
}
