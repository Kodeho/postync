/**
 * C9 — règles de média, logique pure.
 *
 * Ces tests figent ce que C8 a coûté à découvrir en conditions réelles : les
 * plateformes n'ont pas les mêmes exigences, et le clip 16:9 qui est passé
 * sur Instagram aurait été refusé par Facebook.
 */
import { describe, expect, it } from "vitest";

import {
  ALLOWED_MIME_TYPES,
  MAX_BYTE_SIZE,
  canStoreMore,
  checkMediaForPlatform,
  describeRatio,
  extensionForMime,
  formatBytes,
  formatDuration,
  isAllowedMimeType,
  mimeToKind,
  sanitizeFilename,
} from "@/server/media/rules";

const media = (over: Partial<Parameters<typeof checkMediaForPlatform>[0]> = {}) => ({
  mime_type: "video/mp4",
  kind: "video" as const,
  width: 720,
  height: 1280,
  duration_seconds: 30,
  ...over,
});

describe("types acceptés", () => {
  it("liste fermée, alignée sur les plafonds du bucket", () => {
    expect(ALLOWED_MIME_TYPES).toEqual(["video/mp4", "video/quicktime", "image/jpeg"]);
    expect(MAX_BYTE_SIZE).toBe(314_572_800);
    expect(isAllowedMimeType("video/mp4")).toBe(true);
    // Ni exécutable, ni PNG (Instagram n'accepte que le JPEG).
    expect(isAllowedMimeType("application/x-msdownload")).toBe(false);
    expect(isAllowedMimeType("image/png")).toBe(false);
  });

  it("le type déclaré détermine la nature et l'extension", () => {
    expect(mimeToKind("image/jpeg")).toBe("image");
    expect(mimeToKind("video/quicktime")).toBe("video");
    expect(mimeToKind("text/html")).toBeNull();
    expect(extensionForMime("video/quicktime")).toBe("mov");
    expect(extensionForMime("image/jpeg")).toBe("jpg");
  });
});

describe("nom de fichier", () => {
  it("les séparateurs de chemin sont neutralisés", () => {
    // Le nom ne sert qu'à l'affichage — le chemin réel est un UUID — mais on
    // ne laisse pas passer de quoi ressembler à une traversée de répertoire.
    expect(sanitizeFilename("../../etc/passwd")).toBe("..-..-etc-passwd");
    expect(sanitizeFilename("dossier\\fichier.mp4")).toBe("dossier-fichier.mp4");
    expect(sanitizeFilename("  ma video.mp4  ")).toBe("ma video.mp4");
    expect(sanitizeFilename("   ")).toBe("sans-nom");
    expect(sanitizeFilename("a".repeat(400)).length).toBe(255);
  });
});

describe("Reel Facebook — le plus strict", () => {
  it("9:16, bonne durée et bonne résolution : accepté", () => {
    expect(checkMediaForPlatform(media(), "facebook", "reel", "Facebook")).toEqual([]);
  });

  it("le clip 16:9 qui est passé sur Instagram est REFUSÉ", () => {
    // Cas réel : Big Buck Bunny 1280x720 publié sur Instagram en C8.4b.
    const violations = checkMediaForPlatform(
      media({ width: 1280, height: 720, duration_seconds: 10 }),
      "facebook",
      "reel",
      "Facebook",
    );
    expect(violations.map((v) => v.code)).toContain("aspect_ratio");
    expect(violations.map((v) => v.code)).toContain("resolution");
    expect(violations[0].message).toContain("9:16");
    expect(violations[0].message).toContain("16:9");
  });

  it("plus de 90 secondes : refusé", () => {
    const violations = checkMediaForPlatform(
      media({ duration_seconds: 120 }),
      "facebook",
      "reel",
      "Facebook",
    );
    expect(violations.map((v) => v.code)).toEqual(["too_long"]);
    expect(violations[0].message).toContain("90 secondes");
  });

  it("moins de 3 secondes : refusé", () => {
    expect(
      checkMediaForPlatform(media({ duration_seconds: 2 }), "facebook", "reel", "Facebook").map(
        (v) => v.code,
      ),
    ).toEqual(["too_short"]);
  });

  it("bon ratio mais résolution insuffisante : refusé", () => {
    expect(
      checkMediaForPlatform(
        media({ width: 270, height: 480 }),
        "facebook",
        "reel",
        "Facebook",
      ).map((v) => v.code),
    ).toEqual(["resolution"]);
  });
});

describe("Reel Instagram — beaucoup plus permissif", () => {
  it("le même clip 16:9 est accepté", () => {
    expect(
      checkMediaForPlatform(
        media({ width: 1280, height: 720, duration_seconds: 10 }),
        "instagram",
        "reel",
        "Instagram",
      ),
    ).toEqual([]);
  });

  it("jusqu'à 15 minutes", () => {
    expect(
      checkMediaForPlatform(media({ duration_seconds: 890 }), "instagram", "reel", "Instagram"),
    ).toEqual([]);
    expect(
      checkMediaForPlatform(media({ duration_seconds: 1000 }), "instagram", "reel", "Instagram")
        .map((v) => v.code),
    ).toEqual(["too_long"]);
  });
});

describe("Reel TikTok — bornes hautes ET basses", () => {
  it("une verticale ordinaire passe", () => {
    expect(checkMediaForPlatform(media(), "tiktok", "reel", "TikTok")).toEqual([]);
  });

  it("aucun ratio n'est imposé : TikTok n'en documente pas", () => {
    // En inventer un refuserait des vidéos que la plateforme accepte —
    // exactement l'inverse du service rendu. Le 16:9 passe donc, alors qu'il
    // est refusé par Facebook.
    expect(
      checkMediaForPlatform(
        media({ width: 1280, height: 720, duration_seconds: 10 }),
        "tiktok",
        "reel",
        "TikTok",
      ),
    ).toEqual([]);
  });

  it("plus de 10 minutes : refusé", () => {
    const violations = checkMediaForPlatform(
      media({ duration_seconds: 601 }),
      "tiktok",
      "reel",
      "TikTok",
    );
    expect(violations.map((v) => v.code)).toEqual(["too_long"]);
    expect(violations[0].message).toContain("10 min");
  });

  it("exactement 10 minutes : accepté", () => {
    expect(checkMediaForPlatform(media({ duration_seconds: 600 }), "tiktok", "reel", "TikTok")).toEqual(
      [],
    );
  });

  it("aucune durée minimale n'est inventée", () => {
    // La documentation TikTok n'en publie pas. Facebook et Instagram exigent
    // 3 secondes ; les recopier ici serait une contrainte sans source.
    expect(
      checkMediaForPlatform(media({ duration_seconds: 2 }), "tiktok", "reel", "TikTok"),
    ).toEqual([]);
  });

  it("sous 360 pixels : refusé", () => {
    expect(
      checkMediaForPlatform(media({ width: 320, height: 568 }), "tiktok", "reel", "TikTok").map(
        (v) => v.code,
      ),
    ).toEqual(["resolution"]);
  });

  it("au-delà de 4096 pixels : refusé — la borne HAUTE existe aussi", () => {
    // Elle est propre à TikTok : c'est le seul réseau à en documenter une.
    const violations = checkMediaForPlatform(
      media({ width: 4320, height: 7680 }),
      "tiktok",
      "reel",
      "TikTok",
    );
    expect(violations.map((v) => v.code)).toEqual(["resolution"]);
    expect(violations[0].message).toContain("4096");
  });

  it("la borne haute ne s'applique qu'à TikTok", () => {
    // Instagram n'en documente aucune : lui en imposer une refuserait des
    // médias qu'il accepte.
    expect(
      checkMediaForPlatform(
        media({ width: 4320, height: 7680, duration_seconds: 10 }),
        "instagram",
        "reel",
        "Instagram",
      ),
    ).toEqual([]);
  });

  it("TikTok ne publie pas d'image isolée par cette API", () => {
    expect(
      checkMediaForPlatform(
        media({ mime_type: "image/jpeg", kind: "image" }),
        "tiktok",
        "image",
        "TikTok",
      ).map((v) => v.code),
    ).toEqual(["unsupported_kind"]);
  });
});

describe("images", () => {
  it("Instagram n'accepte que le JPEG", () => {
    expect(
      checkMediaForPlatform(
        media({ mime_type: "image/jpeg", kind: "image", duration_seconds: null }),
        "instagram",
        "image",
        "Instagram",
      ),
    ).toEqual([]);
  });

  it("Facebook ne prend pas encore l'image sur Page", () => {
    const violations = checkMediaForPlatform(
      media({ mime_type: "image/jpeg", kind: "image", duration_seconds: null }),
      "facebook",
      "image",
      "Facebook",
    );
    expect(violations.map((v) => v.code)).toEqual(["unsupported_kind"]);
  });
});

describe("média non mesuré", () => {
  it("durée inconnue : refus explicite plutôt que publication à l'aveugle", () => {
    expect(
      checkMediaForPlatform(media({ duration_seconds: null }), "facebook", "reel", "Facebook").map(
        (v) => v.code,
      ),
    ).toContain("not_measured");
  });

  it("dimensions inconnues : refus quand la plateforme les exige", () => {
    expect(
      checkMediaForPlatform(
        media({ width: null, height: null }),
        "facebook",
        "reel",
        "Facebook",
      ).map((v) => v.code),
    ).toContain("not_measured");
  });
});

describe("affichage", () => {
  it("ratios connus nommés, sinon valeur approchée", () => {
    expect(describeRatio(9 / 16)).toBe("9:16");
    expect(describeRatio(16 / 9)).toBe("16:9");
    expect(describeRatio(1)).toBe("1:1");
    expect(describeRatio(3)).toBe("3.00:1");
  });

  it("durées et tailles lisibles", () => {
    // Exactitude d'abord : arrondir 90 s à « 2 min » rendrait un refus
    // incompréhensible pour une vidéo de 100 secondes.
    expect(formatDuration(90)).toBe("90 secondes");
    expect(formatDuration(119)).toBe("119 secondes");
    expect(formatDuration(900)).toBe("15 min");
    expect(formatDuration(150)).toBe("2 min 30 s");
    expect(formatBytes(512)).toBe("512 o");
    // Au-dela de 10, pas de decimale : « 14 Mo » se lit mieux que « 13.7 Mo ».
    expect(formatBytes(14_390_087)).toBe("14 Mo");
    expect(formatBytes(5_400_000)).toBe("5.1 Mo");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 Go");
  });
});

describe("quota de stockage", () => {
  it("le plan borne le total, fichier à venir compris", () => {
    const unGo = 1024 * 1024 * 1024;
    expect(canStoreMore(0, unGo, 1)).toBe(true);
    expect(canStoreMore(unGo, 1, 1)).toBe(false);
    // Le fichier qui tient tout juste passe.
    expect(canStoreMore(unGo - 100, 100, 1)).toBe(true);
  });
});
