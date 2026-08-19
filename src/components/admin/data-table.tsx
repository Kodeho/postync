import Link from "next/link";
import type { ReactNode } from "react";

import { Panel } from "@/components/ui/panel";

/** Tableau dans un panneau, avec défilement horizontal propre sur petit écran. */
export function DataTable({
  caption,
  head,
  children,
  empty,
}: {
  caption: string;
  head: ReactNode;
  children: ReactNode;
  /** Affiché à la place du tableau quand il n'y a aucune ligne. */
  empty?: ReactNode;
}) {
  if (empty) {
    return (
      <Panel className="px-6 py-12 text-center text-sm text-muted">{empty}</Panel>
    );
  }
  return (
    <Panel className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-surface-muted/60 text-xs uppercase tracking-wide text-muted">
            <tr>{head}</tr>
          </thead>
          <tbody className="divide-y divide-border">{children}</tbody>
        </table>
      </div>
    </Panel>
  );
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <th scope="col" className={`px-4 py-2.5 font-medium ${className}`}>
      {children}
    </th>
  );
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
}

/** Pagination par liens (GET), conservant les filtres courants. */
export function Pagination({
  page,
  pageSize,
  total,
  buildHref,
}: {
  page: number;
  pageSize: number;
  total: number;
  buildHref: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <nav aria-label="Pagination" className="flex items-center justify-between text-sm text-muted">
      <p>
        {from}–{to} sur {total}
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={buildHref(page - 1)} className="rounded-md border border-border bg-surface px-3 py-1.5 hover:bg-surface-muted">
            Précédent
          </Link>
        ) : null}
        <span>
          Page {page} / {pages}
        </span>
        {page < pages ? (
          <Link href={buildHref(page + 1)} className="rounded-md border border-border bg-surface px-3 py-1.5 hover:bg-surface-muted">
            Suivant
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
