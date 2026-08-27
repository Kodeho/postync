import type { SocialPlatform } from "@/types/platform";

/**
 * Règles de média — logique PURE, sans dépendance serveur.
 *
 * Ce fichier est la mémoire de ce que C8 a coûté à découvrir : les
 * plateformes n'ont PAS les mêmes exigences, et s'en apercevoir au moment de
 * publier est trop tard. Un Reel Facebook impose le 9:16 et 90 secondes là où
 * Instagram accepte presque tout ratio jusqu'à 15 minutes — le clip 16:9 qui
 * est passé sur Instagram aurait été refusé par Facebook.
 *
 * Toutes les valeurs viennent de la documentation officielle vérifiée en
 * C8.4 (developers.facebook.com, 2026-08-27).
 */

export type MediaKind = "video" | "image";
export type MediaStatus = "uploading" | "ready" | "invalid";

export type MediaAsset = {
  id: string;
  workspace_id: string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  kind: MediaKind;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  video_codec: string | null;
  status: MediaStatus;
  status_detail: string | null;
  created_at: string;
};

/** Types acceptés, alignés sur les plafonds posés au niveau du bucket. */
export const ALLOWED_MIME_TYPES = ["video/mp4", "video/quicktime", "image/jpeg"] as const;
export const MAX_BYTE_SIZE = 314_572_800; // 300 Mo

export function mimeToKind(mimeType: string): MediaKind | null {
  if (mimeType === "image/jpeg") return "image";
  if (mimeType === "video/mp4" || mimeType === "video/quicktime") return "video";
  return null;
}

export function isAllowedMimeType(mimeType: string): boolean {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Extension déduite du type déclaré — jamais du nom de fichier fourni par
 * l'utilisateur, qui n'est pas une source de vérité.
 */
export function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    case "image/jpeg":
      return "jpg";
    default:
      return "bin";
  }
}

/**
 * Nom de fichier nettoyé pour l'affichage. Le nom d'origine ne sert JAMAIS à
 * construire un chemin de stockage : celui-ci est un UUID, ce qui écarte
 * d'un coup la traversée de répertoire et les collisions.
 */
export function sanitizeFilename(name: string): string {
  const trimmed = name.trim().replace(/[\r\n\t]/g, " ");
  const cleaned = trimmed.replace(/[/\\]/g, "-");
  return cleaned.slice(0, 255) || "sans-nom";
}

// ---------------------------------------------------------------------------
// Contraintes par plateforme
// ---------------------------------------------------------------------------

export type PlatformMediaRules = {
  /** Durée en secondes. */
  minDuration?: number;
  maxDuration?: number;
  /** Ratio largeur/hauteur imposé, avec sa tolérance. */
  requiredAspectRatio?: { value: number; tolerance: number; label: string };
  minWidth?: number;
  minHeight?: number;
  allowedMimeTypes: readonly string[];
};

/**
 * Reels. Les écarts entre plateformes sont réels et documentés :
 * Facebook impose le 9:16 et 90 secondes, Instagram est très permissif.
 */
export const REEL_RULES: Partial<Record<SocialPlatform, PlatformMediaRules>> = {
  instagram: {
    minDuration: 3,
    maxDuration: 900,
    allowedMimeTypes: ["video/mp4", "video/quicktime"],
  },
  facebook: {
    minDuration: 3,
    maxDuration: 90,
    requiredAspectRatio: { value: 9 / 16, tolerance: 0.02, label: "9:16" },
    minWidth: 540,
    minHeight: 960,
    allowedMimeTypes: ["video/mp4", "video/quicktime"],
  },
};

export const IMAGE_RULES: Partial<Record<SocialPlatform, PlatformMediaRules>> = {
  // Instagram n'accepte que le JPEG — vérifié dans la documentation.
  instagram: { allowedMimeTypes: ["image/jpeg"] },
};

export type MediaRuleViolation = {
  code:
    | "mime_not_supported"
    | "too_short"
    | "too_long"
    | "aspect_ratio"
    | "resolution"
    | "not_measured"
    | "unsupported_kind";
  /** Phrase prête à afficher, plateforme comprise. */
  message: string;
};

/**
 * Le média convient-il à CETTE plateforme pour CE type de publication ?
 * Renvoie la liste des raisons de refus — vide si tout va bien.
 */
export function checkMediaForPlatform(
  asset: Pick<MediaAsset, "mime_type" | "kind" | "width" | "height" | "duration_seconds">,
  platform: SocialPlatform,
  mediaKind: "reel" | "image",
  platformLabel: string,
): MediaRuleViolation[] {
  const rules = mediaKind === "reel" ? REEL_RULES[platform] : IMAGE_RULES[platform];
  if (!rules) {
    return [
      {
        code: "unsupported_kind",
        message: `${platformLabel} ne prend pas encore en charge ce type de publication.`,
      },
    ];
  }

  const violations: MediaRuleViolation[] = [];

  if (!rules.allowedMimeTypes.includes(asset.mime_type)) {
    violations.push({
      code: "mime_not_supported",
      message: `${platformLabel} n'accepte pas ce format de fichier.`,
    });
  }

  if (mediaKind === "reel") {
    if (asset.duration_seconds === null) {
      violations.push({
        code: "not_measured",
        message: "La durée de cette vidéo n'a pas pu être mesurée.",
      });
    } else {
      if (rules.minDuration !== undefined && asset.duration_seconds < rules.minDuration) {
        violations.push({
          code: "too_short",
          message: `${platformLabel} exige au moins ${rules.minDuration} secondes.`,
        });
      }
      if (rules.maxDuration !== undefined && asset.duration_seconds > rules.maxDuration) {
        violations.push({
          code: "too_long",
          message: `${platformLabel} n'accepte pas plus de ${formatDuration(rules.maxDuration)}.`,
        });
      }
    }
  }

  if (rules.requiredAspectRatio || rules.minWidth || rules.minHeight) {
    if (asset.width === null || asset.height === null || asset.height === 0) {
      violations.push({
        code: "not_measured",
        message: "Les dimensions de ce média n'ont pas pu être mesurées.",
      });
    } else {
      const ratio = asset.width / asset.height;
      if (
        rules.requiredAspectRatio &&
        Math.abs(ratio - rules.requiredAspectRatio.value) > rules.requiredAspectRatio.tolerance
      ) {
        violations.push({
          code: "aspect_ratio",
          message: `${platformLabel} exige un format ${rules.requiredAspectRatio.label} ; ce média est en ${describeRatio(ratio)}.`,
        });
      }
      if (
        (rules.minWidth !== undefined && asset.width < rules.minWidth) ||
        (rules.minHeight !== undefined && asset.height < rules.minHeight)
      ) {
        violations.push({
          code: "resolution",
          message: `${platformLabel} exige au moins ${rules.minWidth} × ${rules.minHeight} pixels ; ce média fait ${asset.width} × ${asset.height}.`,
        });
      }
    }
  }

  return violations;
}

/**
 * Durée lisible, et surtout EXACTE. Arrondir 90 secondes à « 2 min » rendrait
 * incompréhensible le refus d'une vidéo de 100 secondes : sous deux minutes
 * on garde donc les secondes, au-delà on n'arrondit que si c'est juste.
 */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 120) return `${total} secondes`;
  const minutes = Math.floor(total / 60);
  const reste = total % 60;
  return reste === 0 ? `${minutes} min` : `${minutes} min ${reste} s`;
}

/** Ratio lisible : « 16:9 », « 9:16 », sinon la valeur approchée. */
export function describeRatio(ratio: number): string {
  const connus: [number, string][] = [
    [9 / 16, "9:16"],
    [16 / 9, "16:9"],
    [1, "1:1"],
    [4 / 5, "4:5"],
  ];
  for (const [valeur, label] of connus) {
    if (Math.abs(ratio - valeur) < 0.02) return label;
  }
  return `${ratio.toFixed(2)}:1`;
}

/** Taille lisible, pour l'affichage de la médiathèque et des quotas. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ["Ko", "Mo", "Go"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Le quota `storageGb` du plan est-il déjà atteint ? */
export function canStoreMore(currentBytes: number, addedBytes: number, quotaGb: number): boolean {
  return currentBytes + addedBytes <= quotaGb * 1024 * 1024 * 1024;
}
