import Link from "next/link";

import { PRODUCT_NAME } from "@/config/product";
import { LEGAL_LAST_UPDATED, missingLegalFields } from "@/config/legal";

import { PublicFooter } from "./public-footer";

/**
 * Cadre commun aux documents légaux.
 *
 * Deux exigences peu spectaculaires mais décisives : ces pages doivent rester
 * LISIBLES (mesure de ligne contenue, hiérarchie claire) et CITABLES — chaque
 * section porte un identifiant, pour qu'un tiers puisse pointer un article
 * précis plutôt que le document entier.
 */

export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  const manquants = missingLegalFields();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-border px-6 py-4">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight text-foreground hover:opacity-80"
        >
          {PRODUCT_NAME}
        </Link>
      </header>

      <main className="flex-1 px-6 py-10">
        <article className="mx-auto flex max-w-3xl flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
            <p className="mt-1 text-xs text-muted">
              Dernière mise à jour : {formatLegalDate(LEGAL_LAST_UPDATED)}
            </p>
          </div>

          {manquants.length > 0 ? <MissingLegalNotice fields={manquants} /> : null}

          {intro ? <div className="text-sm text-muted">{intro}</div> : null}

          <div className="flex flex-col gap-8">{children}</div>
        </article>
      </main>

      <PublicFooter />
    </div>
  );
}

/**
 * Avertissement affiché tant qu'une mention obligatoire manque.
 *
 * Volontairement visible : un document légal incomplet mis en ligne sans que
 * personne ne le remarque est exactement ce qu'il faut éviter.
 */
function MissingLegalNotice({ fields }: { fields: string[] }) {
  return (
    <div
      role="status"
      className="rounded-md border border-warning/30 bg-warning-soft p-4 text-sm text-warning"
    >
      <p className="font-medium">Document incomplet — à finaliser avant la mise en production.</p>
      <p className="mt-1">Informations obligatoires manquantes :</p>
      <ul className="mt-1 list-disc pl-5">
        {fields.map((champ) => (
          <li key={champ}>{champ}</li>
        ))}
      </ul>
    </div>
  );
}

export function LegalSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-titre`} className="flex flex-col gap-3">
      <h2 id={`${id}-titre`} className="text-base font-semibold text-foreground">
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-foreground">{children}</div>
    </section>
  );
}

/** Valeur légale absente : on le DIT, on ne laisse pas un blanc ambigu. */
export function LegalValue({ value }: { value: string | null }) {
  if (value && value.trim().length > 0) {
    return <>{value}</>;
  }
  return <span className="font-medium text-danger">à compléter</span>;
}

function formatLegalDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
