/**
 * Libellés et résumés des entrées d'audit — logique pure.
 *
 * Les actions journalisées en base suivent le format `cible.evenement`.
 * Aucun secret ne transite ici : les metadata ne contiennent que des valeurs
 * métier (from/to, ends_at, reason).
 */

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "user.suspended": "Compte suspendu",
  "user.reactivated": "Compte réactivé",
  "user.role_changed": "Rôle plateforme modifié",
  "workspace.full_access_granted": "Full Access accordé",
  "workspace.full_access_revoked": "Full Access retiré",
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

const ROLE_LABELS: Record<string, string> = {
  user: "user",
  support: "support",
  admin: "admin",
  super_admin: "super_admin",
};

/** Résumé lisible d'une entrée, à partir de son action et de ses metadata. */
export function summarizeAudit(
  action: string,
  metadata: Record<string, unknown> | null | undefined,
): string {
  const m = metadata ?? {};
  const str = (key: string): string | null => {
    const v = m[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  switch (action) {
    case "user.role_changed": {
      const from = str("from");
      const to = str("to");
      const base = from && to ? `${ROLE_LABELS[from] ?? from} → ${ROLE_LABELS[to] ?? to}` : "";
      return str("source") === "manual_bootstrap" ? `${base} (amorçage manuel)` : base;
    }
    case "user.suspended":
    case "user.reactivated": {
      const from = str("from");
      const to = str("to");
      return from && to ? `${from} → ${to}` : "";
    }
    case "workspace.full_access_granted": {
      const ends = str("ends_at");
      const reason = str("reason");
      const until = ends ? `jusqu'au ${formatDate(ends)}` : "sans expiration";
      return reason ? `${until} — ${reason}` : until;
    }
    case "workspace.full_access_revoked": {
      const reason = str("reason");
      return reason ?? "";
    }
    default:
      return "";
  }
}

/** Format date/heure court, stable côté serveur (fr-FR, UTC explicite). */
export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: withTime ? "short" : undefined,
    timeZone: "UTC",
  }).format(date);
}
