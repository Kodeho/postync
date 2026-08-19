import type { WorkspaceRole } from "@/types/workspace-role";

/** Libellés des rôles workspace (distincts de `platform_role`). */
export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/**
 * Initiales pour un avatar : "Ludovic Piraino" -> "LP", "Kodeho" -> "K",
 * "ludovic@example.com" -> "L". Toujours 1 à 2 caractères, en majuscules.
 */
export function initials(label: string | null | undefined): string {
  const cleaned = (label ?? "").trim();
  if (!cleaned) {
    return "?";
  }
  // Pour une adresse e-mail, seule la partie locale compte.
  const base = cleaned.includes("@") ? cleaned.split("@")[0] : cleaned;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase() || cleaned[0].toUpperCase();
}

/** Classe de couleur d'avatar, déterministe à partir d'une graine (id). */
export function avatarToneClass(seed: string): string {
  // Palette volontairement réduite : trois teintes douces, déterministes.
  const tones = [
    "bg-primary-soft text-primary",
    "bg-success-soft text-success",
    "bg-warning-soft text-warning",
  ];
  let hash = 0;
  for (const ch of seed) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return tones[Math.abs(hash) % tones.length];
}
