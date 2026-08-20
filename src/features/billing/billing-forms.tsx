"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { openBillingPortalAction, startCheckoutAction } from "@/server/stripe/actions";
import { IDLE_BILLING_ACTION } from "@/server/stripe/action-state";

/**
 * Formulaires client de la page billing. Aucun Price ID ne transite ici :
 * seuls un slug, un plan et un intervalle sont soumis — tout est revérifié et
 * résolu côté serveur.
 */

export function CheckoutButton({
  workspaceSlug,
  plan,
  interval,
  label,
  current,
  variant = "primary",
}: {
  workspaceSlug: string;
  plan: string;
  interval: string;
  label: string;
  current: boolean;
  variant?: "primary" | "secondary";
}) {
  const [state, action] = useActionState(startCheckoutAction, IDLE_BILLING_ACTION);

  if (current) {
    return (
      <p className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-surface-muted px-4 text-sm font-medium text-muted">
        Plan actuel
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <input type="hidden" name="plan" value={plan} />
      <input type="hidden" name="interval" value={interval} />
      {variant === "primary" ? (
        <SubmitButton label={label} pendingLabel="Redirection…" />
      ) : (
        <Button type="submit" variant="secondary" size="sm">
          {label}
        </Button>
      )}
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
    </form>
  );
}

export function BillingPortalButton({ workspaceSlug }: { workspaceSlug: string }) {
  const [state, action] = useActionState(openBillingPortalAction, IDLE_BILLING_ACTION);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <SubmitButton label="Gérer mon abonnement" pendingLabel="Ouverture…" />
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
    </form>
  );
}
