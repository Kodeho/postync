/**
 * Non-régression du contrat `SocialPublisher` — Facebook et Instagram.
 *
 * POURQUOI CE FICHIER EXISTE. Le chantier TikTok a ajouté deux champs
 * FACULTATIFS à `CreateContainerInput` : `durationSeconds` (TikTok plafonne la
 * durée par créateur) et `privacyLevel` (TikTok impose `SELF_ONLY` tant que
 * son client n'est pas audité). Le moteur `publish.ts` les renseigne
 * désormais pour TOUTES les plateformes — il ne sait pas laquelle en a
 * l'usage.
 *
 * Le risque est donc précis : qu'un champ pensé pour TikTok se glisse dans une
 * requête Meta. Un paramètre inconnu vaut HTTP 400 chez Meta, pas une omission
 * silencieuse — la publication Instagram et Facebook casserait d'un coup, en
 * production, pour une raison qui n'a rien à voir avec elles.
 *
 * Ces tests comparent donc la requête émise AVEC et SANS les nouveaux champs.
 * Ils doivent être identiques, à l'octet près.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { facebookPublisher } from "@/server/social/providers/facebook";
import { instagramPublisher } from "@/server/social/providers/instagram";
import { tiktokPublisher } from "@/server/social/providers/tiktok-publisher";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mockFetchSequence(...responses: Response[]) {
  const mock = vi.spyOn(globalThis, "fetch");
  mock.mockImplementation(() => {
    throw new Error("appel fetch inattendu : la séquence simulée est épuisée");
  });
  for (const response of responses) {
    mock.mockResolvedValueOnce(response);
  }
  return mock;
}

/** Les deux champs ajoutés pour TikTok, valorisés de façon bien visible. */
const CHAMPS_TIKTOK = { durationSeconds: 42, privacyLevel: "PUBLIC_TO_EVERYONE" } as const;

beforeEach(() => {
  process.env.INSTAGRAM_APP_ID = "test-ig-app-id";
  process.env.INSTAGRAM_APP_SECRET = "test-ig-app-secret";
  process.env.META_CLIENT_ID = "test-meta-id";
  process.env.META_CLIENT_SECRET = "test-meta-secret";
});

afterEach(() => {
  delete process.env.INSTAGRAM_APP_ID;
  delete process.env.INSTAGRAM_APP_SECRET;
  delete process.env.META_CLIENT_ID;
  delete process.env.META_CLIENT_SECRET;
  vi.restoreAllMocks();
});

describe("Instagram ignore les champs propres à TikTok", () => {
  const base = {
    accessToken: "IGAA.long-lived",
    providerAccountId: "17841400000000000",
    mediaKind: "reel" as const,
    mediaUrl: "https://cdn.example.com/reel.mp4",
    caption: "Bonjour",
  };

  it("le corps envoyé à /media est identique, à l'octet près", async () => {
    const sans = mockFetchSequence(json({ id: "c1" }));
    await instagramPublisher.createContainer(base);
    const corpsSans = String(sans.mock.calls[0][1]?.body);
    vi.restoreAllMocks();

    const avec = mockFetchSequence(json({ id: "c1" }));
    await instagramPublisher.createContainer({ ...base, ...CHAMPS_TIKTOK });
    const corpsAvec = String(avec.mock.calls[0][1]?.body);

    expect(corpsAvec).toBe(corpsSans);
    // Un paramètre inconnu vaut HTTP 400 chez Meta : la vérification
    // explicite vaut mieux qu'une égalité qu'on pourrait mal lire.
    expect(corpsAvec).not.toContain("privacy");
    expect(corpsAvec).not.toContain("duration");
    expect(corpsAvec).not.toContain("42");
  });
});

describe("Facebook ignore les champs propres à TikTok", () => {
  const base = {
    accessToken: "EAAPageToken",
    providerAccountId: "111222333444555",
    mediaKind: "reel" as const,
    mediaUrl: "https://cdn.example.com/reel.mp4",
    caption: "Bonjour",
  };

  it("les phases start et upload sont inchangées", async () => {
    const sans = mockFetchSequence(json({ video_id: "7788" }), json({ success: true }));
    await facebookPublisher.createContainer(base);
    const startSans = String(sans.mock.calls[0][1]?.body);
    const uploadSans = JSON.stringify(sans.mock.calls[1][1]?.headers);
    vi.restoreAllMocks();

    const avec = mockFetchSequence(json({ video_id: "7788" }), json({ success: true }));
    await facebookPublisher.createContainer({ ...base, ...CHAMPS_TIKTOK });

    expect(String(avec.mock.calls[0][1]?.body)).toBe(startSans);
    expect(JSON.stringify(avec.mock.calls[1][1]?.headers)).toBe(uploadSans);
  });
});

describe("les trois publishers respectent le même contrat", () => {
  it("chacun déclare ses scopes, ses médias et ses trois opérations", () => {
    // Une capacité manquante ne se voit qu'à la publication, c'est-à-dire
    // trop tard. `publish.ts` appelle ces trois méthodes sans condition.
    for (const [nom, publisher] of [
      ["instagram", instagramPublisher],
      ["facebook", facebookPublisher],
      ["tiktok", tiktokPublisher],
    ] as const) {
      expect(publisher.requiredScopes.length, nom).toBeGreaterThan(0);
      expect(publisher.supportedMediaKinds.length, nom).toBeGreaterThan(0);
      expect(typeof publisher.createContainer, nom).toBe("function");
      expect(typeof publisher.containerStatus, nom).toBe("function");
      expect(typeof publisher.publishContainer, nom).toBe("function");
    }
  });

  it("les scopes de publication restent cloisonnés par plateforme", () => {
    // Un scope TikTok qui apparaîtrait dans la liste Meta ferait échouer la
    // vérification de `publish.ts` et réclamerait une reconnexion à tort.
    expect(instagramPublisher.requiredScopes).toEqual(["instagram_business_content_publish"]);
    expect(tiktokPublisher.requiredScopes).toEqual(["video.publish"]);
    expect(facebookPublisher.requiredScopes.join(",")).not.toContain("video.publish");
  });
});
