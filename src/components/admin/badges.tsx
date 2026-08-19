type Tone = "neutral" | "success" | "warning" | "danger" | "primary";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-muted text-muted",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  primary: "bg-primary-soft text-primary",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function AccountStatusBadge({ status }: { status: string }) {
  const tone: Tone = status === "active" ? "success" : status === "suspended" ? "danger" : "warning";
  const label = status === "active" ? "Actif" : status === "suspended" ? "Suspendu" : "Désactivé";
  return <Badge tone={tone}>{label}</Badge>;
}

export function PlatformRoleBadge({ role }: { role: string }) {
  const tone: Tone =
    role === "super_admin" ? "danger" : role === "admin" ? "primary" : role === "support" ? "warning" : "neutral";
  return <Badge tone={tone}>{role}</Badge>;
}

/** `active` = Full Access effectif, calculé par la couche requêtes (hors rendu). */
export function AccessModeBadge({ mode, active }: { mode: string; active: boolean }) {
  if (mode !== "full_access") {
    return <Badge>standard</Badge>;
  }
  return <Badge tone={active ? "success" : "warning"}>{active ? "full_access" : "full_access (expiré)"}</Badge>;
}

export function WorkspaceRoleBadge({ role }: { role: string }) {
  return <Badge tone={role === "owner" ? "primary" : "neutral"}>{role}</Badge>;
}
