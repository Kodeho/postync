import type { ReactNode } from "react";

type PageHeaderProps = {
  title: string;
  description?: string;
  /** Action principale (bouton ou lien-bouton), optionnelle. */
  actions?: ReactNode;
};

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>
        ) : null}
      </div>
      {/*
        `flex-wrap` : deux actions cote a cote debordent sur un telephone. Elles
        passent a la ligne plutot que de rogner le titre ou de forcer un
        defilement horizontal.
      */}
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-start gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
