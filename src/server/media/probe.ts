import "server-only";

/**
 * Mesure d'un média à partir de son en-tête, côté SERVEUR.
 *
 * Pourquoi ne pas laisser le navigateur mesurer : il suffirait de mentir sur
 * les dimensions pour qu'un média soit marqué « prêt » puis refusé par la
 * plateforme au moment de publier. La mesure doit venir du fichier lui-même.
 *
 * Pourquoi ce n'est pas coûteux : les informations recherchées vivent dans
 * l'atome `moov`, et Meta exige de toute façon qu'il soit EN TÊTE du fichier.
 * Quelques centaines de kilo-octets suffisent donc — on ne télécharge jamais
 * les 300 Mo.
 *
 * Ce parseur a été éprouvé en conditions réelles pendant C8 : c'est lui qui a
 * démasqué une vidéo candidate dont l'atome `moov` était en fin de fichier,
 * ce que Meta refuse et qui aurait produit un échec opaque.
 */

/** Fenêtre lue en tête de fichier : large pour un `moov` volumineux. */
export const PROBE_BYTES = 512 * 1024;

export type MediaProbe = {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  videoCodec: string | null;
  /** `moov` présent en tête : exigence explicite de Meta. */
  fastStart: boolean;
};

export type ProbeFailure =
  | "fetch_failed"
  | "not_a_container"
  | "moov_not_found"
  | "no_video_track";

type Box = { type: string; start: number; end: number };

function* boxes(buf: Uint8Array, view: DataView, start: number, end: number): Generator<Box> {
  let i = start;
  while (i + 8 <= end) {
    let size = view.getUint32(i);
    const type = String.fromCharCode(buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]);
    if (size === 0) size = end - i;
    // Un atome plus petit que son en-tête signale un flux corrompu ou tronqué.
    if (size < 8) return;
    yield { type, start: i + 8, end: Math.min(i + size, end) };
    i += size;
  }
}

function findBox(
  buf: Uint8Array,
  view: DataView,
  path: string[],
  start: number,
  end: number,
): Box | null {
  for (const box of boxes(buf, view, start, end)) {
    if (box.type !== path[0]) continue;
    if (path.length === 1) return box;
    const deeper = findBox(buf, view, path.slice(1), box.start, box.end);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Analyse un conteneur MP4/MOV. Renvoie les caractéristiques, ou la raison
 * pour laquelle le fichier n'est pas exploitable.
 */
export function probeMp4(bytes: Uint8Array): MediaProbe | ProbeFailure {
  if (bytes.byteLength < 16) return "not_a_container";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const ftyp = findBox(bytes, view, ["ftyp"], 0, bytes.byteLength);
  if (!ftyp) return "not_a_container";

  const moov = findBox(bytes, view, ["moov"], 0, bytes.byteLength);
  if (!moov) {
    // Soit le fichier est énorme et `moov` est au-delà de la fenêtre lue,
    // soit il est en fin de fichier. Dans les deux cas Meta le refusera.
    return "moov_not_found";
  }

  let durationSeconds: number | null = null;
  const mvhd = findBox(bytes, view, ["mvhd"], moov.start, moov.end);
  if (mvhd) {
    const version = bytes[mvhd.start];
    const timescale = version === 1 ? view.getUint32(mvhd.start + 20) : view.getUint32(mvhd.start + 12);
    const duration =
      version === 1
        ? Number(view.getBigUint64(mvhd.start + 24))
        : view.getUint32(mvhd.start + 16);
    if (timescale > 0) durationSeconds = Math.round((duration / timescale) * 1000) / 1000;
  }

  let width: number | null = null;
  let height: number | null = null;
  let videoCodec: string | null = null;

  for (const trak of boxes(bytes, view, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;

    const tkhd = findBox(bytes, view, ["tkhd"], trak.start, trak.end);
    if (tkhd) {
      // Largeur et hauteur occupent les 8 derniers octets, en virgule fixe 16.16.
      const w = view.getUint32(tkhd.end - 8) / 65536;
      const h = view.getUint32(tkhd.end - 4) / 65536;
      if (w > 0 && h > 0) {
        width = Math.round(w);
        height = Math.round(h);
      }
    }

    const stsd = findBox(bytes, view, ["mdia", "minf", "stbl", "stsd"], trak.start, trak.end);
    if (stsd) {
      // Le premier descripteur suit un en-tête de 8 octets (version + count).
      for (const entry of boxes(bytes, view, stsd.start + 8, stsd.end)) {
        if (["avc1", "avc3", "hvc1", "hev1", "vp09", "av01"].includes(entry.type)) {
          videoCodec = entry.type;
          break;
        }
      }
    }
    // Une piste porteuse d'image ET de codec : c'est la piste vidéo.
    if (width !== null && videoCodec !== null) break;
  }

  if (width === null || height === null) return "no_video_track";

  return {
    width,
    height,
    durationSeconds,
    videoCodec,
    // `moov` avant le premier `mdat` : le fichier est lisible en streaming.
    fastStart: isFastStart(bytes, view, moov),
  };
}

function isFastStart(bytes: Uint8Array, view: DataView, moov: Box): boolean {
  for (const box of boxes(bytes, view, 0, bytes.byteLength)) {
    if (box.type === "mdat") return box.start > moov.start;
    if (box.type === "moov") return true;
  }
  // Aucun `mdat` dans la fenêtre lue : `moov` est bien devant.
  return true;
}

/**
 * Télécharge l'en-tête d'un média par requête à plage puis l'analyse.
 * L'URL est une URL signée à courte durée, jamais conservée.
 */
export async function probeRemoteMedia(
  url: string,
  mimeType: string,
): Promise<MediaProbe | ProbeFailure> {
  // Une image JPEG n'a ni durée ni piste : rien à mesurer ici, et Instagram
  // ne pose pas de contrainte de dimensions sur les images.
  if (mimeType === "image/jpeg") {
    return { width: null, height: null, durationSeconds: null, videoCodec: null, fastStart: true };
  }

  let response: Response;
  try {
    response = await fetch(url, { headers: { range: `bytes=0-${PROBE_BYTES - 1}` } });
  } catch {
    return "fetch_failed";
  }
  // 206 pour une plage servie, 200 si le serveur renvoie tout le fichier.
  if (response.status !== 206 && response.status !== 200) {
    return "fetch_failed";
  }

  const buffer = await response.arrayBuffer();
  return probeMp4(new Uint8Array(buffer));
}

/** Message court et non technique pour l'utilisateur. */
export function probeFailureMessage(failure: ProbeFailure): string {
  switch (failure) {
    case "not_a_container":
      return "Ce fichier n'est pas une vidéo MP4 ou MOV exploitable.";
    case "moov_not_found":
      return "Cette vidéo doit être enregistrée avec ses métadonnées en tête de fichier (« fast start ») pour être acceptée par les plateformes.";
    case "no_video_track":
      return "Aucune piste vidéo n'a été trouvée dans ce fichier.";
    case "fetch_failed":
      return "Le fichier téléversé n'a pas pu être relu pour analyse.";
  }
}
