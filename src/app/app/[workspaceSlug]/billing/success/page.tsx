import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { Panel } from "@/components/ui/panel";
import { getWorkspaceContext } from "@/features/workspaces/context";

export const metadata: Metadata = {
  title: "Paiement reçu — POSTYNC",
};

/**
 * Retour de Stripe Checkout. Cette page N'ACTIVE JAMAIS l'abonnement : seul
 * le webhook signé fait foi. Elle informe simplement que la synchronisation
 * est en cours.
 */
export default async function BillingSuccessPage({
  params,
}: PageProps<"/app/[workspaceSlug]/billing/success">) {
  await connection();
  const { workspaceSlug } = await params;
  await getWorkspaceContext(workspaceSlug);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 py-10 text-center">
      <Panel className="p-8">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Paiement reçu.
        </h1>
        <p className="mt-2 text-sm text-muted">
          Synchronisation de votre abonnement… Cela ne prend généralement que
          quelques secondes.
        </p>
        <p className="mt-6">
          <Link
            href={`/app/${workspaceSlug}/billing`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Voir mon abonnement
          </Link>
        </p>
      </Panel>
    </div>
  );
}
