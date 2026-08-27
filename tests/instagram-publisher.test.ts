/**
 * C8.4b — publication Instagram : conformité à « Content Publishing » de la
 * documentation officielle Meta. `fetch` simulé, aucun appel réseau.
 *
 * Ce que ces tests protègent en particulier :
 *   - l'hôte est `graph.instagram.com` (et non `graph.facebook.com`, qui vaut
 *     pour la configuration Facebook Login) ;
 *   - la publication se fait en DEUX temps, et jamais en un seul ;
 *   - un conteneur encore en traitement n'est jamais publié ;
 *   - aucune erreur brute de Meta ne remonte, seulement un code court.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instagramPublisher } from "@/server/social/providers/instagram";
import { SocialPublishError } from "@/server/social/providers/types";

const IG_ID = "17841400000000000";
const TOKEN = "IGAA.long-lived";

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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  process.env.INSTAGRAM_APP_ID = "test-ig-app-id";
  process.env.INSTAGRAM_APP_SECRET = "test-ig-app-secret";
});

afterEach(() => {
  delete process.env.INSTAGRAM_APP_ID;
  delete process.env.INSTAGRAM_APP_SECRET;
  vi.restoreAllMocks();
});

describe("capacités déclarées", () => {
  it("exige le scope de publication et annonce les médias supportés", () => {
    expect(instagramPublisher.requiredScopes).toEqual(["instagram_business_content_publish"]);
    expect(instagramPublisher.supportedMediaKinds).toEqual(["reel", "image"]);
  });
});

describe("création du conteneur", () => {
  it("Reel : media_type=REELS + video_url sur graph.instagram.com versionné", async () => {
    const fetchMock = mockFetchSequence(json({ id: "container-1" }));

    const containerId = await instagramPublisher.createContainer({
      accessToken: TOKEN,
      providerAccountId: IG_ID,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/reel.mp4",
      caption: "Bonjour",
      coverUrl: "https://cdn.example.com/cover.jpg",
      shareToFeed: true,
    });

    const [url, init] = fetchMock.mock.calls[0];
    // Hôte Instagram : graph.facebook.com vaut pour l'autre configuration.
    expect(String(url)).toBe(`https://graph.instagram.com/v25.0/${IG_ID}/media`);
    expect(init?.method).toBe("POST");

    const body = new URLSearchParams(String(init?.body));
    expect(body.get("media_type")).toBe("REELS");
    expect(body.get("video_url")).toBe("https://cdn.example.com/reel.mp4");
    expect(body.get("caption")).toBe("Bonjour");
    expect(body.get("cover_url")).toBe("https://cdn.example.com/cover.jpg");
    expect(body.get("share_to_feed")).toBe("true");
    expect(body.get("access_token")).toBe(TOKEN);
    // Un Reel n'est pas une image.
    expect(body.get("image_url")).toBeNull();

    expect(containerId).toBe("container-1");
  });

  it("Image : image_url seul, sans media_type ni paramètres réservés aux Reels", async () => {
    const fetchMock = mockFetchSequence(json({ id: "container-2" }));

    await instagramPublisher.createContainer({
      accessToken: TOKEN,
      providerAccountId: IG_ID,
      mediaKind: "image",
      mediaUrl: "https://cdn.example.com/photo.jpg",
      caption: null,
      shareToFeed: true,
    });

    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.get("image_url")).toBe("https://cdn.example.com/photo.jpg");
    expect(body.get("media_type")).toBeNull();
    expect(body.get("video_url")).toBeNull();
    // `share_to_feed` n'existe que pour les Reels : ne pas l'envoyer ailleurs.
    expect(body.get("share_to_feed")).toBeNull();
    expect(body.get("caption")).toBeNull();
  });

  it("légende trop longue : refusée AVANT tout appel réseau", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      instagramPublisher.createContainer({
        accessToken: TOKEN,
        providerAccountId: IG_ID,
        mediaKind: "reel",
        mediaUrl: "https://cdn.example.com/reel.mp4",
        caption: "x".repeat(2201),
      }),
    ).rejects.toMatchObject({ code: "caption_too_long" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("échec Meta : code court, sans fuite du message brut", async () => {
    mockFetchSequence(
      json(
        { error: { type: "OAuthException", code: 100, message: "detail-interne-sensible" } },
        400,
      ),
    );
    const error = await instagramPublisher
      .createContainer({
        accessToken: TOKEN,
        providerAccountId: IG_ID,
        mediaKind: "reel",
        mediaUrl: "https://cdn.example.com/reel.mp4",
        caption: null,
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SocialPublishError);
    expect((error as SocialPublishError).code).toBe("http_400");
    expect((error as Error).message).not.toContain("detail-interne-sensible");
    // Le token ne doit jamais se retrouver dans un message d'erreur.
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("réponse sans identifiant de conteneur : rejetée", async () => {
    mockFetchSequence(json({}));
    await expect(
      instagramPublisher.createContainer({
        accessToken: TOKEN,
        providerAccountId: IG_ID,
        mediaKind: "image",
        mediaUrl: "https://cdn.example.com/photo.jpg",
        caption: null,
      }),
    ).rejects.toMatchObject({ code: "container_missing" });
  });
});

describe("statut du conteneur", () => {
  const cases: [string, string][] = [
    ["FINISHED", "ready"],
    ["IN_PROGRESS", "processing"],
    ["PUBLISHED", "published"],
    ["EXPIRED", "expired"],
    ["ERROR", "failed"],
  ];

  for (const [code, expected] of cases) {
    it(`${code} devient « ${expected} »`, async () => {
      const fetchMock = mockFetchSequence(json({ status_code: code, id: "container-1" }));
      const status = await instagramPublisher.containerStatus({
        accessToken: TOKEN,
        containerId: "container-1",
      });
      expect(status).toBe(expected);
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.origin + url.pathname).toBe("https://graph.instagram.com/v25.0/container-1");
      expect(url.searchParams.get("fields")).toBe("status_code");
    });
  }

  it("statut inconnu : traité comme « en cours », jamais comme publiable", async () => {
    mockFetchSequence(json({ status_code: "SOMETHING_NEW" }));
    const status = await instagramPublisher.containerStatus({
      accessToken: TOKEN,
      containerId: "container-1",
    });
    // Ne jamais publier sur la foi d'un statut qu'on ne comprend pas.
    expect(status).toBe("processing");
  });
});

describe("publication du conteneur", () => {
  it("POST media_publish avec creation_id ; renvoie l'identifiant du média", async () => {
    const fetchMock = mockFetchSequence(json({ id: "media-9" }));
    const result = await instagramPublisher.publishContainer({
      accessToken: TOKEN,
      providerAccountId: IG_ID,
      containerId: "container-1",
    });

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://graph.instagram.com/v25.0/${IG_ID}/media_publish`,
    );
    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.get("creation_id")).toBe("container-1");
    expect(result.providerMediaId).toBe("media-9");
  });

  it("identifiant numérique converti en chaîne", async () => {
    mockFetchSequence(json({ id: 17_895_695_668_004_550 }));
    const result = await instagramPublisher.publishContainer({
      accessToken: TOKEN,
      providerAccountId: IG_ID,
      containerId: "container-1",
    });
    expect(typeof result.providerMediaId).toBe("string");
  });
});

describe("permalien et quota plateforme", () => {
  it("permalien lu sur le média publié", async () => {
    const fetchMock = mockFetchSequence(json({ permalink: "https://www.instagram.com/reel/abc/" }));
    const permalink = await instagramPublisher.fetchPermalink!({
      accessToken: TOKEN,
      providerMediaId: "media-9",
    });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("fields")).toBe("permalink");
    expect(permalink).toBe("https://www.instagram.com/reel/abc/");
  });

  it("permalien indisponible : null, jamais une erreur (affichage seulement)", async () => {
    mockFetchSequence(json({ error: { type: "OAuthException", code: 100 } }, 400));
    await expect(
      instagramPublisher.fetchPermalink!({ accessToken: TOKEN, providerMediaId: "media-9" }),
    ).resolves.toBeNull();
  });

  it("quota plateforme : content_publishing_limit, distinct du quota du plan", async () => {
    const fetchMock = mockFetchSequence(json({ quota_usage: 7, config: { quota_total: 100 } }));
    const quota = await instagramPublisher.remoteQuota!({
      accessToken: TOKEN,
      providerAccountId: IG_ID,
    });
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe(
      `/v25.0/${IG_ID}/content_publishing_limit`,
    );
    expect(quota).toEqual({ used: 7, limit: 100 });
  });
});
