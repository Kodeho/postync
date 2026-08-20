import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { Panel } from "@/components/ui/panel";
import { getWorkspaceContext } from "@/features/workspaces/context";

export const metadata: Metadata = {
  title: "Paiement annulé — POSTYNC",
};

/** Retour de Stripe Checkout après abandon : rien n'a été débité. */
export default async function BillingCancelPage({
  params,
}: PageProps<"/app/[workspaceSlug]/billing/cancel">) {
  await connection();
  const { workspaceSlug } = await params;
  await getWorkspaceContext(workspaceSlug);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 py-10 text-center">
      <Panel className="p-8">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Paiement annulé.
        </h1>
        <p className="mt-2 text-sm text-muted">
          Aucun montant n&apos;a été débité. Vous pouvez reprendre quand vous voulez.
        </p>
        <p className="mt-6">
          <Link
            href={`/app/${workspaceSlug}/billing`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Retour à l&apos;abonnement
          </Link>
        </p>
      </Panel>
    </div>
  );
}
