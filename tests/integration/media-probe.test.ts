/**
 * C9 — analyseur de média, contre de VRAIS fichiers distants.
 *
 * Ces tests utilisent les vidéos qui ont réellement servi pendant C8, et
 * notamment le candidat écarté dont l'atome `moov` est en fin de fichier —
 * ce que Meta refuse et qui aurait produit un échec opaque en pleine
 * publication.
 *
 * Ils dépendent d'un réseau sortant : ignorés si les fichiers ne répondent
 * pas, plutôt que de faire échouer la suite pour une raison externe.
 */
import { describe, expect, it } from "vitest";

import { probeMp4, probeRemoteMedia, PROBE_BYTES } from "@/server/media/probe";

const REEL_9_16 = "https://cdn.truefilesize.com/mp4/sample-portrait.mp4";
const CLIP_16_9 =
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_5MB.mp4";
const MOOV_EN_FIN = "https://examplefiles.org/files/video/mp4-sample-vertical-1080x1920.mp4";

async function joignable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

describe("analyse d'en-tête MP4", () => {
  it("mesure la vidéo 9:16 réellement publiée sur Facebook", async () => {
    if (!(await joignable(REEL_9_16))) return;
    const result = await probeRemoteMedia(REEL_9_16, "video/mp4");
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    // La page annonçait 1080x1920 ; le fichier fait réellement 720x1280.
    // C'est exactement pourquoi on mesure au lieu de croire.
    expect(result.width).toBe(720);
    expect(result.height).toBe(1280);
    expect(result.durationSeconds).toBeCloseTo(30, 0);
    expect(result.videoCodec).toBe("avc1");
    expect(result.fastStart).toBe(true);
    // Ratio 9:16, conforme aux Reels Facebook.
    expect(result.width! / result.height!).toBeCloseTo(0.5625, 2);
  }, 60_000);

  it("mesure le clip 16:9 publié sur Instagram", async () => {
    if (!(await joignable(CLIP_16_9))) return;
    const result = await probeRemoteMedia(CLIP_16_9, "video/mp4");
    if (typeof result === "string") return;

    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
    expect(result.durationSeconds).toBeCloseTo(10, 0);
    expect(result.videoCodec).toBe("avc1");
  }, 60_000);

  it("REFUSE un fichier dont l'atome moov est en fin de fichier", async () => {
    if (!(await joignable(MOOV_EN_FIN))) return;
    // Meta exige `moov` en tête. Ce candidat avait été écarté pendant C8 :
    // accepté, il aurait échoué côté plateforme sans explication utile.
    const result = await probeRemoteMedia(MOOV_EN_FIN, "video/mp4");
    expect(result).toBe("moov_not_found");
  }, 60_000);

  it("une image JPEG n'a rien à mesurer", async () => {
    const result = await probeRemoteMedia("https://exemple.invalide/x.jpg", "image/jpeg");
    expect(result).toEqual({
      width: null,
      height: null,
      durationSeconds: null,
      videoCodec: null,
      fastStart: true,
    });
  });
});

describe("robustesse de l'analyseur", () => {
  it("octets vides ou trop courts : refusés sans lever d'exception", () => {
    expect(probeMp4(new Uint8Array(0))).toBe("not_a_container");
    expect(probeMp4(new Uint8Array(8))).toBe("not_a_container");
  });

  it("contenu quelconque : refusé, jamais interprété", () => {
    const texte = new TextEncoder().encode("<html>ceci n'est pas une video</html>");
    expect(probeMp4(texte)).toBe("not_a_container");
  });

  it("taille de fenêtre suffisante pour un moov volumineux", () => {
    // Assez large pour un `moov` de plusieurs centaines de Ko, sans jamais
    // télécharger les 300 Mo autorisés par le bucket.
    expect(PROBE_BYTES).toBeGreaterThanOrEqual(256 * 1024);
    expect(PROBE_BYTES).toBeLessThan(2 * 1024 * 1024);
  });
});
