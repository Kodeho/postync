/**
 * C8.2 — provider YouTube : conformité au flux « web server » officiel Google
 * (URL d'autorisation, échange de code, refresh, révocation, identité de
 * chaîne). `fetch` simulé : aucun appel réseau, aucun identifiant réel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SocialIdentityUnavailableError } from "@/server/social/providers/types";
import {
  YOUTUBE_SCOPES,
  isYouTubeConfigured,
  youtubeProvider,
} from "@/server/social/providers/youtube";

const REDIRECT = "https://postync.test/api/oauth/youtube/callback";

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
});

afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("provider proposé uniquement si les deux identifiants sont présents", () => {
    expect(isYouTubeConfigured()).toBe(true);
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(isYouTubeConfigured()).toBe(false);
  });
});

describe("URL d'autorisation (doc web-server officielle)", () => {
  it("endpoint, code flow, moindre privilège, offline + consent + incrémental", () => {
    const url = new URL(
      youtubeProvider.buildAuthUrl({ state: "state-opaque", codeChallenge: null, redirectUri: REDIRECT }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("response_type")).toBe("code");
    // Séparateur ESPACE — spécificité Google, là où TikTok veut des virgules.
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.readonly " +
        "https://www.googleapis.com/auth/youtube.upload",
    );
    expect(url.searchParams.get("state")).toBe("state-opaque");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    // Client confidentiel : pas de PKCE dans le flux web-server documenté.
    expect(youtubeProvider.usesPkce).toBe(false);
    expect(url.searchParams.get("code_challenge")).toBeNull();
    // Jamais de secret dans une URL.
    expect(url.toString()).not.toContain("test-client-secret");
  });

  it("demande la lecture de la chaîne ET l'envoi, et rien de plus", () => {
    // La borne HAUTE est le vrai sujet. `videos.insert` accepte aussi
    // `youtube`, `youtube.force-ssl` et `youtubepartner` — tous bien plus
    // larges que ce dont POSTYNC a besoin. `youtube.upload` est le minimum
    // qui autorise l'envoi, et c'est celui-là qu'on prend.
    //
    // `youtube.readonly` reste parce qu'il SERT : il porte
    // `channels.list?mine=true`, seul moyen d'identifier la chaîne connectée
    // et de détecter un compte Google qui n'en a aucune. `youtube.upload`
    // seul ne donne pas cette lecture.
    expect(YOUTUBE_SCOPES).toEqual([
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.upload",
    ]);
    // Aucun scope large ne doit s'y glisser.
    for (const large of ["auth/youtube ", "force-ssl", "youtubepartner"]) {
      expect(YOUTUBE_SCOPES.join(" ") + " ").not.toContain(large);
    }
  });
});

describe("échange de code et refresh", () => {
  it("échange : POST form vers oauth2.googleapis.com/token avec client_secret ; TokenSet complet", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "at-123",
          refresh_token: "rt-456",
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/youtube.readonly",
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );

    const tokens = await youtubeProvider.exchangeCode({
      code: "auth-code",
      codeVerifier: null,
      redirectUri: REDIRECT,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("redirect_uri")).toBe(REDIRECT);

    expect(tokens.accessToken).toBe("at-123");
    expect(tokens.refreshToken).toBe("rt-456");
    expect(tokens.scopes).toEqual(["https://www.googleapis.com/auth/youtube.readonly"]);
    expect(new Date(tokens.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("échange en échec HTTP : erreur SANS fuite du corps de réponse", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant", secret_hint: "ne-doit-pas-fuiter" }), {
        status: 400,
      }),
    );
    await expect(
      youtubeProvider.exchangeCode({ code: "bad", codeVerifier: null, redirectUri: REDIRECT }),
    ).rejects.toThrow("google token: HTTP 400 invalid_grant");
  });

  it("refresh : grant_type=refresh_token ; refresh token absent -> null (l'appelant garde l'ancien)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }), { status: 200 }),
    );
    const tokens = await youtubeProvider.refresh!("rt-456");
    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-456");
    expect(tokens.accessToken).toBe("at-new");
    expect(tokens.refreshToken).toBeNull();
  });
});

describe("identité de chaîne", () => {
  it("channels.list?part=snippet&mine=true avec Bearer ; mapping id/titre/avatar", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "UCabc123",
              snippet: {
                title: "Chaîne POSTYNC Test",
                thumbnails: { default: { url: "https://yt.example/avatar.jpg" } },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const identity = await youtubeProvider.fetchIdentity!("at-123");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/channels");
    expect(url.searchParams.get("part")).toBe("snippet");
    expect(url.searchParams.get("mine")).toBe("true");
    expect(identity).toEqual({
      providerAccountId: "UCabc123",
      displayName: "Chaîne POSTYNC Test",
      avatarUrl: "https://yt.example/avatar.jpg",
    });
  });

  it("compte Google sans chaîne (items vide) : SocialIdentityUnavailableError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    await expect(youtubeProvider.fetchIdentity!("at-123")).rejects.toBeInstanceOf(
      SocialIdentityUnavailableError,
    );
  });

  it("401 youtubeSignupRequired (cas réel du E2E) : SocialIdentityUnavailableError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 401, errors: [{ reason: "youtubeSignupRequired" }] } }),
        { status: 401 },
      ),
    );
    await expect(youtubeProvider.fetchIdentity!("at-123")).rejects.toBeInstanceOf(
      SocialIdentityUnavailableError,
    );
  });
});

describe("révocation", () => {
  it("révoque le refresh token en priorité (révoque aussi les access tokens associés)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await youtubeProvider.revoke!({ accessToken: "at-123", refreshToken: "rt-456" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://oauth2.googleapis.com/revoke");
    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.get("token")).toBe("rt-456");
  });
});
