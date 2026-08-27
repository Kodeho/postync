/**
 * C8.4c — provider Facebook : conformité à la documentation officielle Meta
 * (Facebook Login, /me/accounts, Reels publishing). `fetch` simulé, aucun
 * appel réseau.
 *
 * Ce que ces tests protègent en particulier :
 *   - Facebook n'a PAS d'identité unique : il expose des ACTIFS ;
 *   - le jeton court est systématiquement converti en jeton longue durée,
 *     faute de quoi les jetons de Page dérivés seraient éphémères ;
 *   - une Page sans droit de publication n'est jamais présentée comme
 *     publiable ;
 *   - la publication se fait en TROIS phases, pas deux.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FACEBOOK_SCOPES,
  facebookAssets,
  facebookProvider,
  facebookPublisher,
  isFacebookConfigured,
} from "@/server/social/providers/facebook";
import { SocialPublishError } from "@/server/social/providers/types";

const REDIRECT = "https://postync.vercel.app/api/oauth/facebook/callback";
const PAGE_ID = "111222333444555";
const PAGE_TOKEN = "EAAPageToken";

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
  process.env.META_CLIENT_ID = "test-fb-app-id";
  process.env.META_CLIENT_SECRET = "test-fb-app-secret";
});

afterEach(() => {
  delete process.env.META_CLIENT_ID;
  delete process.env.META_CLIENT_SECRET;
  vi.restoreAllMocks();
});

describe("configuration et forme du provider", () => {
  it("provider proposé uniquement si l'App ID ET le secret sont présents", () => {
    expect(isFacebookConfigured()).toBe(true);
    delete process.env.META_CLIENT_SECRET;
    expect(isFacebookConfigured()).toBe(false);
  });

  it("provider À ACTIFS : pas d'identité unique, mais un sélecteur", () => {
    // Une autorisation Facebook donne N Pages : `fetchIdentity` n'aurait
    // aucun sens ici, le callback doit passer par la sélection.
    expect(facebookProvider.fetchIdentity).toBeUndefined();
    expect(facebookProvider.assets).toBe(facebookAssets);
  });

  it("scopes minimaux ; publish_video n'est PAS requis pour les Reels", () => {
    expect(FACEBOOK_SCOPES).toEqual([
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
    ]);
    // Vérifié dans la doc : publish_video concerne la vidéo EN DIRECT.
    expect(FACEBOOK_SCOPES).not.toContain("publish_video");
    expect(FACEBOOK_SCOPES).not.toContain("business_management");
  });

  it("aucune révocation câblée, mais une notice explicite", () => {
    // `DELETE /permissions` couperait TOUTES les Pages d'un coup :
    // déconnecter une Page ne doit pas en révoquer d'autres.
    expect(facebookProvider.revoke).toBeUndefined();
    expect(facebookProvider.revokeNotice).toMatch(/Facebook/);
  });
});

describe("URL d'autorisation", () => {
  it("dialogue versionné, scopes dans l'URL, state — sans secret", () => {
    const url = new URL(
      facebookProvider.buildAuthUrl({
        state: "state-opaque",
        codeChallenge: null,
        redirectUri: REDIRECT,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v25.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("test-fb-app-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("state-opaque");
    expect(url.searchParams.get("scope")).toBe(
      "pages_show_list,pages_read_engagement,pages_manage_posts",
    );
    expect(facebookProvider.usesPkce).toBe(false);
    expect(url.toString()).not.toContain("test-fb-app-secret");
  });
});

describe("échange de code", () => {
  it("le jeton court est TOUJOURS converti en jeton longue durée", async () => {
    const fetchMock = mockFetchSequence(
      json({ access_token: "EAA.short", token_type: "bearer", expires_in: 3600 }),
      json({ access_token: "EAA.long", token_type: "bearer", expires_in: 5_184_000 }),
    );

    const tokens = await facebookProvider.exchangeCode({
      code: "auth-code",
      codeVerifier: null,
      redirectUri: REDIRECT,
    });

    const first = new URL(String(fetchMock.mock.calls[0][0]));
    expect(first.origin + first.pathname).toBe("https://graph.facebook.com/v25.0/oauth/access_token");
    expect(first.searchParams.get("code")).toBe("auth-code");
    expect(first.searchParams.get("client_secret")).toBe("test-fb-app-secret");

    const second = new URL(String(fetchMock.mock.calls[1][0]));
    expect(second.searchParams.get("grant_type")).toBe("fb_exchange_token");
    expect(second.searchParams.get("fb_exchange_token")).toBe("EAA.short");

    // Sans cette conversion, les jetons de Page dérivés seraient éphémères.
    expect(tokens.accessToken).toBe("EAA.long");
    expect(tokens.refreshToken).toBeNull();
    const jours = (new Date(tokens.expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(jours).toBeGreaterThan(59);
  });

  it("échec : code court, sans fuite du message Meta", async () => {
    mockFetchSequence(
      json({ error: { type: "OAuthException", code: 100, message: "detail-sensible" } }, 400),
    );
    const error = await facebookProvider
      .exchangeCode({ code: "bad", codeVerifier: null, redirectUri: REDIRECT })
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(error?.message).toBe("facebook token: HTTP 400 OAuthException/100");
    expect(error?.message).not.toContain("detail-sensible");
  });
});

describe("énumération des Pages", () => {
  it("GET /me/accounts ; tasks détermine la publication possible", async () => {
    const fetchMock = mockFetchSequence(
      json({
        data: [
          {
            id: PAGE_ID,
            name: "Kodeho Studio",
            access_token: PAGE_TOKEN,
            tasks: ["ANALYZE", "CREATE_CONTENT", "MANAGE"],
            picture: { data: { url: "https://fb.example/avatar.jpg" } },
          },
          {
            id: "999",
            name: "Page en lecture seule",
            access_token: "EAAOther",
            tasks: ["ANALYZE"],
          },
        ],
      }),
    );

    const assets = await facebookAssets.listAssets("EAA.long");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v25.0/me/accounts");
    expect(url.searchParams.get("fields")).toContain("tasks");

    expect(assets).toEqual([
      {
        assetId: PAGE_ID,
        name: "Kodeho Studio",
        avatarUrl: "https://fb.example/avatar.jpg",
        token: PAGE_TOKEN,
        canPublish: true,
      },
      {
        assetId: "999",
        name: "Page en lecture seule",
        avatarUrl: null,
        token: "EAAOther",
        // Sans CREATE_CONTENT, la Page ne doit pas être annoncée publiable.
        canPublish: false,
      },
    ]);
  });

  it("une Page sans jeton est ignorée plutôt que proposée", async () => {
    mockFetchSequence(
      json({ data: [{ id: "1", name: "Sans jeton", tasks: ["CREATE_CONTENT"] }] }),
    );
    await expect(facebookAssets.listAssets("EAA.long")).resolves.toEqual([]);
  });

  it("pagination suivie jusqu'au bout", async () => {
    mockFetchSequence(
      json({
        data: [{ id: "1", name: "A", access_token: "t1", tasks: ["CREATE_CONTENT"] }],
        paging: { next: "https://graph.facebook.com/v25.0/me/accounts?after=abc" },
      }),
      json({
        data: [{ id: "2", name: "B", access_token: "t2", tasks: ["CREATE_CONTENT"] }],
      }),
    );
    const assets = await facebookAssets.listAssets("EAA.long");
    expect(assets.map((a) => a.assetId)).toEqual(["1", "2"]);
  });

  it("échec : code court, sans fuite", async () => {
    mockFetchSequence(json({ error: { type: "OAuthException", code: 190 } }, 400));
    await expect(facebookAssets.listAssets("EAA.long")).rejects.toThrow(
      "facebook me/accounts: HTTP 400 OAuthException/190",
    );
  });
});

describe("publication d'un Reel", () => {
  it("phases 1 et 2 : start puis transfert par file_url, sans octet via POSTYNC", async () => {
    const fetchMock = mockFetchSequence(
      json({ video_id: "7788" }),
      json({ success: true }),
    );

    const containerId = await facebookPublisher.createContainer({
      accessToken: PAGE_TOKEN,
      providerAccountId: PAGE_ID,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/reel.mp4",
      caption: "Bonjour",
    });

    const [startUrl, startInit] = fetchMock.mock.calls[0];
    expect(String(startUrl)).toBe(`https://graph.facebook.com/v25.0/${PAGE_ID}/video_reels`);
    expect(new URLSearchParams(String(startInit?.body)).get("upload_phase")).toBe("start");

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1];
    expect(String(uploadUrl)).toBe("https://rupload.facebook.com/video-upload/v25.0/7788");
    const headers = uploadInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`OAuth ${PAGE_TOKEN}`);
    // Le média est référencé, pas téléversé par nous.
    expect(headers.file_url).toBe("https://cdn.example.com/reel.mp4");
    expect(uploadInit?.body).toBeUndefined();

    expect(containerId).toBe("7788");
  });

  it("phase 3 : finish avec video_state=PUBLISHED", async () => {
    const fetchMock = mockFetchSequence(json({ success: true }));
    const result = await facebookPublisher.publishContainer({
      accessToken: PAGE_TOKEN,
      providerAccountId: PAGE_ID,
      containerId: "7788",
    });
    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.get("upload_phase")).toBe("finish");
    expect(body.get("video_id")).toBe("7788");
    expect(body.get("video_state")).toBe("PUBLISHED");
    // La phase finish ne renvoie pas d'identifiant : le Reel EST la vidéo.
    expect(result.providerMediaId).toBe("7788");
  });

  it("la legende part en `description` a la phase finish, pas au conteneur", async () => {
    // Contrairement a Instagram, Facebook porte la legende sur la PUBLICATION.
    // L'envoyer a la phase start n'aurait aucun effet : Reel sans texte.
    const startMock = mockFetchSequence(json({ video_id: "7788" }), json({ success: true }));
    await facebookPublisher.createContainer({
      accessToken: PAGE_TOKEN,
      providerAccountId: PAGE_ID,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/reel.mp4",
      caption: "Ma legende",
    });
    expect(
      new URLSearchParams(String(startMock.mock.calls[0][1]?.body)).get("description"),
    ).toBeNull();
    vi.restoreAllMocks();

    const finishMock = mockFetchSequence(json({ success: true }));
    await facebookPublisher.publishContainer({
      accessToken: PAGE_TOKEN,
      providerAccountId: PAGE_ID,
      containerId: "7788",
      caption: "Ma legende",
    });
    expect(
      new URLSearchParams(String(finishMock.mock.calls[0][1]?.body)).get("description"),
    ).toBe("Ma legende");
  });

  it("legende absente : aucun parametre description envoye", async () => {
    const fetchMock = mockFetchSequence(json({ success: true }));
    await facebookPublisher.publishContainer({
      accessToken: PAGE_TOKEN,
      providerAccountId: PAGE_ID,
      containerId: "7788",
      caption: null,
    });
    expect(
      new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get("description"),
    ).toBeNull();
  });

  it("statut : ready seulement quand video_status vaut ready", async () => {
    mockFetchSequence(json({ status: { video_status: "ready" } }));
    await expect(
      facebookPublisher.containerStatus({ accessToken: PAGE_TOKEN, containerId: "7788" }),
    ).resolves.toBe("ready");
  });

  it("statut : traitement en cours, et statut inconnu jamais publiable", async () => {
    mockFetchSequence(
      json({ status: { video_status: "processing" } }),
      json({ status: {} }),
      json({}),
    );
    for (let i = 0; i < 3; i += 1) {
      await expect(
        facebookPublisher.containerStatus({ accessToken: PAGE_TOKEN, containerId: "7788" }),
      ).resolves.toBe("processing");
    }
  });

  it("statut : erreur de traitement remontée comme échec", async () => {
    mockFetchSequence(json({ status: { processing_phase: { status: "error" } } }));
    await expect(
      facebookPublisher.containerStatus({ accessToken: PAGE_TOKEN, containerId: "7788" }),
    ).resolves.toBe("failed");
  });

  it("légende trop longue : refusée avant tout appel réseau", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      facebookPublisher.createContainer({
        accessToken: PAGE_TOKEN,
        providerAccountId: PAGE_ID,
        mediaKind: "reel",
        mediaUrl: "https://cdn.example.com/reel.mp4",
        caption: "x".repeat(2201),
      }),
    ).rejects.toMatchObject({ code: "caption_too_long" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("échec du transfert : code court, jeton absent du message", async () => {
    mockFetchSequence(
      json({ video_id: "7788" }),
      json({ error: { type: "OAuthException", code: 6000 } }, 400),
    );
    const error = await facebookPublisher
      .createContainer({
        accessToken: PAGE_TOKEN,
        providerAccountId: PAGE_ID,
        mediaKind: "reel",
        mediaUrl: "https://cdn.example.com/reel.mp4",
        caption: null,
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SocialPublishError);
    expect((error as SocialPublishError).code).toBe("http_400");
    expect((error as Error).message).not.toContain(PAGE_TOKEN);
  });

  it("seuls les Reels sont supportés pour l'instant", () => {
    expect(facebookPublisher.supportedMediaKinds).toEqual(["reel"]);
    expect(facebookPublisher.requiredScopes).toEqual(["pages_manage_posts"]);
  });

  it("permalien : chemin relatif complété en URL absolue", async () => {
    mockFetchSequence(json({ permalink_url: "/kodeho/videos/7788/" }));
    await expect(
      facebookPublisher.fetchPermalink!({ accessToken: PAGE_TOKEN, providerMediaId: "7788" }),
    ).resolves.toBe("https://www.facebook.com/kodeho/videos/7788/");
  });
});
