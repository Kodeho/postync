"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  grantFullAccessAction,
  reactivateUserAction,
  revokeFullAccessAction,
  setPlatformRoleAction,
  suspendUserAction,
} from "@/server/admin/actions";
import { IDLE_ADMIN_ACTION, type AdminActionState } from "@/server/admin/action-state";
import type { PlatformRole } from "@/types/platform-role";

/**
 * Formulaires des actions d'administration (composants client : seul
 * `useActionState` l'exige). Ils n'embarquent aucune décision d'autorisation :
 * la Server Action et la RPC tranchent ; ici on affiche seulement le résultat.
 */

function Feedback({ state }: { state: AdminActionState }) {
  if (!state.message) return null;
  return <FormAlert tone={state.ok ? "notice" : "error"}>{state.message}</FormAlert>;
}

export function SuspendUserForm({ userId, suspended }: { userId: string; suspended: boolean }) {
  const [state, action] = useActionState(
    suspended ? reactivateUserAction : suspendUserAction,
    IDLE_ADMIN_ACTION,
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="userId" value={userId} />
      <div>
        <SubmitButton
          label={suspended ? "Réactiver le compte" : "Suspendre le compte"}
          pendingLabel="En cours…"
        />
      </div>
      <p className="text-xs text-muted">
        {suspended
          ? "Le compte retrouve immédiatement l'accès à POSTYNC."
          : "Le compte perd l'accès à POSTYNC ; aucune donnée n'est supprimée."}
      </p>
      <Feedback state={state} />
    </form>
  );
}

export function SetRoleForm({
  userId,
  currentRole,
  options,
}: {
  userId: string;
  currentRole: PlatformRole;
  /** Rôles que l'acteur courant a le droit d'attribuer à cette cible. */
  options: PlatformRole[];
}) {
  const [state, action] = useActionState(setPlatformRoleAction, IDLE_ADMIN_ACTION);
  if (options.length === 0) {
    return (
      <p className="text-sm text-muted">
        Vous ne pouvez pas modifier le rôle de ce compte.
      </p>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="userId" value={userId} />
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-foreground">Nouveau rôle plateforme</span>
        <select
          name="role"
          defaultValue=""
          required
          className="h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground shadow-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
        >
          <option value="" disabled>
            Choisir… (actuel : {currentRole})
          </option>
          {options.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </label>
      <div>
        <SubmitButton label="Appliquer le rôle" pendingLabel="En cours…" />
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function GrantFullAccessForm({ workspaceId }: { workspaceId: string }) {
  const [state, action] = useActionState(grantFullAccessAction, IDLE_ADMIN_ACTION);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-foreground">Fin d&apos;accès (optionnel)</span>
        <input
          type="date"
          name="endsAt"
          className="h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground shadow-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
        />
        <span className="text-xs text-muted">Vide = sans expiration.</span>
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-foreground">Raison</span>
        <input
          type="text"
          name="reason"
          maxLength={500}
          placeholder="Ex. : Compte partenaire Kodeho"
          className="h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground shadow-soft placeholder:text-muted-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
        />
      </label>
      <div>
        <SubmitButton label="Accorder Full Access" pendingLabel="En cours…" />
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function RevokeFullAccessForm({ workspaceId }: { workspaceId: string }) {
  const [state, action] = useActionState(revokeFullAccessAction, IDLE_ADMIN_ACTION);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-foreground">Raison du retrait (optionnel)</span>
        <input
          type="text"
          name="reason"
          maxLength={500}
          className="h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground shadow-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
        />
      </label>
      <div>
        <Button type="submit" variant="secondary">
          Retirer Full Access
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
