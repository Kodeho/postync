import type { Metadata } from "next";
import { connection } from "next/server";

import { Badge } from "@/components/admin/badges";
import { FormAlert } from "@/components/ui/form-alert";
import { PageHeader } from "@/components/ui/page-header";
import { VAT_NOTICE } from "@/config/legal";
import { Panel } from "@/components/ui/panel";
import {
  PLANS,
  formatPlanPrice,
  planPriceCents,
  type BillingInterval,
} from "@/config/plans";
import { BillingPortalButton, CheckoutButton } from "@/features/billing/billing-forms";
import { getWorkspaceContext } from "@/features/workspaces/context";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/server/admin/audit";
import { SUBSCRIPTION_STATUS_LABELS } from "@/server/billing/access";
import { getWorkspaceAccess } from "@/server/billing/queries";

export const metadata: Metadata = {
  title: "Abonnement — POSTYNC",
};

/**
 * Page billing du workspace. Les données viennent de la réplique locale
 * synchronisée par le webhook Stripe (RLS : membres du workspace).
 * Seuls owner/admin voient les actions ; le serveur revérifie de toute façon.
 */
export default async function BillingPage({
  params,
}: PageProps<"/app/[workspaceSlug]/billing">) {
  await connection();

  const { workspaceSlug } = await params;
  const ctx = await getWorkspaceContext(workspaceSlug);
  const workspace = ctx.active.workspace;
  const canManage = ctx.active.role === "owner" || ctx.active.role === "admin";

  const supabase = await createClient();
  const { access, subscription } = await getWorkspaceAccess(supabase, workspace.id);

  const interval: BillingInterval = subscription?.interval === "year" ? "year" : "month";
  const priceLabel =
    access.source === "full_access"
      ? "Offert par Kodeho"
      : access.planKey === "free"
        ? "0 €"
        : `${formatPlanPrice(planPriceCents(access.plan, interval))}/${interval === "year" ? "an" : "mois"}`;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Abonnement"
        description="Le plan et la facturation de ce workspace."
      />

      {access.paymentWarning ? (
        <FormAlert tone="error">
          Le dernier paiement a échoué. Votre accès est conservé temporairement :
          mettez à jour votre moyen de paiement via « Gérer mon abonnement ».
        </FormAlert>
      ) : null}

      <Panel as="section" aria-labelledby="billing-plan" className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 id="billing-plan" className="text-sm text-muted">
              Plan actuel
            </h2>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              {access.source === "full_access" ? "Full Access" : access.plan.name}
            </p>
            <p className="mt-0.5 text-sm text-muted">{priceLabel}</p>
          </div>
          <div className="flex flex-col items-end gap-1 text-right">
            {access.source === "full_access" ? (
              <Badge tone="success">Full Access Kodeho</Badge>
            ) : subscription ? (
              <Badge tone={access.paymentWarning ? "warning" : "success"}>
                {SUBSCRIPTION_STATUS_LABELS[subscription.status]}
              </Badge>
            ) : (
              <Badge>Sans abonnement</Badge>
            )}
            {access.source === "full_access" ? (
              <p className="text-xs text-muted">
                {access.endsAt ? `Jusqu'au ${formatDate(access.endsAt)}` : "Sans expiration"}
              </p>
            ) : null}
            {access.source === "subscription" && subscription?.currentPeriodEnd ? (
              <p className="text-xs text-muted">
                {subscription.cancelAtPeriodEnd
                  ? `Prend fin le ${formatDate(subscription.currentPeriodEnd)}`
                  : `Prochain renouvellement : ${formatDate(subscription.currentPeriodEnd)}`}
              </p>
            ) : null}
          </div>
        </div>

        {subscription?.cancelAtPeriodEnd ? (
          <p className="mt-4 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
            L&apos;abonnement est annulé : l&apos;accès payé continue jusqu&apos;à la fin de la
            période, puis le workspace repassera au plan Free.
          </p>
        ) : null}

        {canManage && subscription ? (
          <div className="mt-5 border-t border-border pt-5">
            <BillingPortalButton workspaceSlug={workspace.slug} />
            <p className="mt-2 text-xs text-muted">
              Factures, moyen de paiement et annulation via le portail Stripe.
            </p>
          </div>
        ) : null}
        {!canManage ? (
          <p className="mt-5 border-t border-border pt-5 text-sm text-muted">
            Seul le propriétaire ou un admin du workspace peut gérer l&apos;abonnement.
          </p>
        ) : null}
      </Panel>

      {access.source === "full_access" ? (
        <p className="text-sm text-muted">
          Ce workspace bénéficie d&apos;un accès complet offert par Kodeho : aucun
          abonnement n&apos;est nécessaire tant qu&apos;il est actif.
        </p>
      ) : canManage ? (
        <section aria-labelledby="billing-plans" className="flex flex-col gap-4">
          <h2 id="billing-plans" className="text-base font-semibold text-foreground">
            Changer de plan
          </h2>
          {/* Mention obligatoire tant que l'éditeur relève de la franchise en
              base : les prix affichés ne comportent pas de TVA, et le dire
              n'est pas facultatif. */}
          {VAT_NOTICE ? <p className="text-xs text-muted">{VAT_NOTICE}.</p> : null}
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {PLANS.map((plan) => {
              const isCurrent = access.source !== "free" ? plan.key === access.planKey : plan.key === "free";
              return (
                <li key={plan.key}>
                  <Panel className="flex h-full flex-col gap-3 p-5">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{plan.name}</p>
                      <p className="mt-1 text-xl font-semibold tracking-tight text-foreground">
                        {formatPlanPrice(plan.monthlyPriceCents)}
                        <span className="text-sm font-normal text-muted">/mois</span>
                      </p>
                      {plan.yearlyPriceCents > 0 ? (
                        <p className="text-xs text-muted">
                          ou {formatPlanPrice(plan.yearlyPriceCents)}/an (2 mois offerts)
                        </p>
                      ) : null}
                    </div>
                    <ul className="flex-1 text-xs text-muted">
                      <li>{plan.quotas.workspaces} workspace{plan.quotas.workspaces > 1 ? "s" : ""}</li>
                      <li>
                        {plan.quotas.members === 1
                          ? "1 membre (offre solo)"
                          : `${plan.quotas.members} membres`}
                      </li>
                      <li>{plan.quotas.socialAccounts} comptes sociaux</li>
                      <li>{plan.quotas.publicationsPerMonth.toLocaleString("fr-FR")} publications/mois</li>
                      <li>{plan.quotas.storageGb} Go de stockage</li>
                    </ul>
                    {plan.key === "free" ? (
                      isCurrent ? (
                        <p className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-surface-muted px-4 text-sm font-medium text-muted">
                          Plan actuel
                        </p>
                      ) : (
                        <p className="text-xs text-muted">
                          Retour au plan Free via l&apos;annulation dans le portail.
                        </p>
                      )
                    ) : (
                      <div className="flex flex-col gap-2">
                        <CheckoutButton
                          workspaceSlug={workspace.slug}
                          plan={plan.key}
                          interval="month"
                          label={`Choisir ${plan.name}`}
                          current={isCurrent}
                        />
                        {!isCurrent ? (
                          <CheckoutButton
                            workspaceSlug={workspace.slug}
                            plan={plan.key}
                            interval="year"
                            label="Annuel (2 mois offerts)"
                            current={false}
                            variant="secondary"
                          />
                        ) : null}
                      </div>
                    )}
                  </Panel>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted">Paiement sécurisé par Stripe.</p>
        </section>
      ) : null}
    </div>
  );
}
