/**
 * Budgets de transfert YouTube — confrontation des constantes RÉELLES.
 *
 * POURQUOI CE FICHIER EXISTE. Le 2026-09-01, la première publication YouTube
 * réelle est restée bloquée : `resumeTransfer` se réservait 12 s avant
 * d'engager un morceau, alors que le planificateur ne lui en accordait que 8 et
 * la diffusion interactive exactement 12. La condition de garde était donc
 * vraie DÈS LA PREMIÈRE ITÉRATION, dans les deux cas. Aucun octet ne pouvait
 * partir — sans erreur, sans log, sans échec : la ligne retombait `pending` et
 * était reprise indéfiniment.
 *
 * Les 637 tests d'alors passaient tous. Ils vérifiaient `resumeTransfer` avec
 * une échéance généreuse fournie à la main, et le moteur avec un `pollBudgetMs`
 * surchargé. Les trois constantes n'étaient JAMAIS confrontées entre elles.
 *
 * Ce fichier ne surcharge donc aucun budget : il n'utilise que les valeurs
 * exportées par le code de production.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BROADCAST_POLL_BUDGET_MS } from "@/server/social/broadcast";
import {
  CHUNK_SIZE,
  YOUTUBE_MIN_TRANSFER_BUDGET_MS,
  youtubePublisher,
} from "@/server/social/providers/youtube-publisher";
import { BATCH_SIZE, SCHEDULER_POLL_BUDGET_MS } from "@/server/social/scheduler";

const TOKEN = "ya29.jeton-de-test";
const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=Z";
const MEDIA = "https://api.postync.app/storage/v1/object/sign/media/ws/a.mp4?token=sig";
const VIDEO_ID = "dQw4w9WgXcQ";

/**
 * Session résumable simulée, qui tient la position comme le ferait Google.
 * `dejaRecu` permet de rejouer une reprise après interruption.
 */
function mockSession(total: number, dejaRecu = 0) {
  let recu = dejaRecu;
  const appels = { positions: 0, envois: 0, ouvertures: 0 };
  const mock = vi.spyOn(globalThis, "fetch");
  mock.mockImplementation(async (input, init) => {
    const url = String(input);
    const methode = init?.method ?? "GET";

    if (methode === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-length": String(total) } });
    }
    // Une ouverture de session est un POST sur l'API : elle ne doit JAMAIS
    // survenir pendant une reprise.
    if (methode === "POST" && url.includes("uploadType=resumable")) {
      appels.ouvertures += 1;
      return new Response(null, { status: 200, headers: { location: SESSION } });
    }

    const plage = (init?.headers as Record<string, string> | undefined)?.["content-range"];
    if (plage?.startsWith("bytes */")) {
      appels.positions += 1;
      return recu === 0
        ? new Response(null, { status: 308 })
        : new Response(null, { status: 308, headers: { range: `bytes=0-${recu - 1}` } });
    }
    if (plage) {
      appels.envois += 1;
      const bornes = /bytes (\d+)-(\d+)\//.exec(plage);
      if (bornes) recu = Number(bornes[2]) + 1;
      return recu >= total
        ? new Response(JSON.stringify({ id: VIDEO_ID }), { status: 200 })
        : new Response(null, { status: 308 });
    }

    const demande = (init?.headers as Record<string, string> | undefined)?.range;
    const bornes = /bytes=(\d+)-(\d+)/.exec(demande ?? "");
    const taille = bornes ? Number(bornes[2]) - Number(bornes[1]) + 1 : CHUNK_SIZE;
    return new Response(new Uint8Array(taille), {
      status: 206,
      headers: { "content-length": String(taille) },
    });
  });
  return { mock, appels, position: () => recu };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("compatibilité des budgets réels", () => {
  it("le planificateur accorde de quoi tenter au moins un morceau", () => {
    // C'est LA condition qui manquait. `8_000 < 4_500` était faux, donc la
    // panne ; mais rien ne le vérifiait.
    expect(SCHEDULER_POLL_BUDGET_MS).toBeGreaterThanOrEqual(YOUTUBE_MIN_TRANSFER_BUDGET_MS);
  });

  it("la diffusion interactive accorde de quoi tenter au moins un morceau", () => {
    expect(BROADCAST_POLL_BUDGET_MS).toBeGreaterThanOrEqual(YOUTUBE_MIN_TRANSFER_BUDGET_MS);
  });

  it("le pire lot du planificateur tient dans maxDuration", () => {
    // La valeur est lue DANS la route, pas recopiée : les deux ne peuvent pas
    // diverger sans que ce test le dise.
    const route = readFileSync(
      join(process.cwd(), "src/app/api/cron/publish/route.ts"),
      "utf8",
    );
    const declaree = /export const maxDuration = (\d+)/.exec(route);
    expect(declaree).not.toBeNull();
    const maxDurationMs = Number(declaree![1]) * 1_000;

    // Un réveil traite au pire BATCH_SIZE échéances dues PUIS BATCH_SIZE
    // reprises, chacune bornée par le budget.
    const pire = 2 * BATCH_SIZE * SCHEDULER_POLL_BUDGET_MS;
    expect(pire).toBeLessThan(maxDurationMs);
  });
});

describe("progression avec les budgets de production", () => {
  it("transfère au moins un morceau avec le budget du planificateur", async () => {
    const total = CHUNK_SIZE * 3;
    const { appels } = mockSession(total);

    const resultat = await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: Date.now() + SCHEDULER_POLL_BUDGET_MS,
    });

    expect(resultat.pushedBytes).toBeGreaterThanOrEqual(CHUNK_SIZE);
    expect(appels.envois).toBeGreaterThanOrEqual(1);
  });

  it("transfère au moins un morceau avec le budget de la diffusion interactive", async () => {
    const total = CHUNK_SIZE * 3;
    const { appels } = mockSession(total);

    const resultat = await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: Date.now() + BROADCAST_POLL_BUDGET_MS,
    });

    expect(resultat.pushedBytes).toBeGreaterThanOrEqual(CHUNK_SIZE);
    expect(appels.envois).toBeGreaterThanOrEqual(1);
  });

  it("reprend à l'octet confirmé par Google, sans renvoyer le début", async () => {
    const total = CHUNK_SIZE * 3;
    const dejaRecu = CHUNK_SIZE; // un morceau est déjà arrivé
    const { mock } = mockSession(total, dejaRecu);

    await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: Date.now() + SCHEDULER_POLL_BUDGET_MS,
    });

    // La PREMIÈRE tranche demandée au stockage commence à l'octet suivant.
    const lectures = mock.mock.calls
      .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.range)
      .filter((r): r is string => typeof r === "string");
    expect(lectures[0]).toBe(`bytes=${dejaRecu}-${dejaRecu + CHUNK_SIZE - 1}`);
    // Rien n'a été relu depuis zéro.
    expect(lectures.some((r) => r.startsWith("bytes=0-"))).toBe(false);
  });

  it("n'ouvre JAMAIS une seconde session pendant une reprise", async () => {
    const total = CHUNK_SIZE * 3;
    const { appels } = mockSession(total, CHUNK_SIZE);

    await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: Date.now() + SCHEDULER_POLL_BUDGET_MS,
    });

    expect(appels.ouvertures).toBe(0);
    // La position est demandée, jamais supposée.
    expect(appels.positions).toBeGreaterThanOrEqual(1);
  });

  it("mène la session jusqu'au bout quand le média tient dans le budget", async () => {
    const total = Math.floor(CHUNK_SIZE / 4); // un seul morceau suffit
    const { appels } = mockSession(total);

    const resultat = await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: Date.now() + SCHEDULER_POLL_BUDGET_MS,
    });

    expect(resultat.pushedBytes).toBe(total);
    expect(appels.envois).toBe(1);
  });
});

describe("fenêtre insuffisante", () => {
  it("lève un code explicite au lieu de rendre la main en silence", async () => {
    const { mock } = mockSession(CHUNK_SIZE * 3);

    await expect(
      youtubePublisher.resumeTransfer!({
        accessToken: TOKEN,
        containerId: SESSION,
        mediaUrl: MEDIA,
        // Exactement le budget qui a bloqué la production.
        deadline: Date.now() + 1_000,
      }),
    ).rejects.toMatchObject({ code: "transfer_window_too_small" });

    // Et surtout : aucun appel réseau, donc aucune boucle silencieuse.
    expect(mock).not.toHaveBeenCalled();
  });

  it("le budget fautif d'origine serait aujourd'hui refusé", async () => {
    // 8 000 ms — la valeur exacte de SCHEDULER_POLL_BUDGET_MS avant correctif —
    // dépasse désormais le seuil, donc le transfert démarre.
    const { appels } = mockSession(CHUNK_SIZE * 2);
    const resultat = await youtubePublisher.resumeTransfer!({
      accessToken: TOKEN,
      containerId: SESSION,
      mediaUrl: MEDIA,
      deadline: Date.now() + 8_000,
    });
    expect(resultat.pushedBytes).toBeGreaterThan(0);
    expect(appels.envois).toBeGreaterThanOrEqual(1);
  });
});
