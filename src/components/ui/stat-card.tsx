import { Panel } from "./panel";

type StatCardProps = {
  label: string;
  /** `null` = donnée pas encore disponible, affichée « — ». */
  value: number | string | null;
  hint?: string;
};

export function StatCard({ label, value, hint }: StatCardProps) {
  const display = value === null ? "—" : String(value);
  return (
    <Panel className="p-5">
      <p className="text-sm text-muted">{label}</p>
      <p
        className="mt-2 text-3xl font-semibold tracking-tight text-foreground tabular-nums"
        aria-label={value === null ? `${label} : aucune donnée` : undefined}
      >
        {display}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted-soft">{hint}</p> : null}
    </Panel>
  );
}
