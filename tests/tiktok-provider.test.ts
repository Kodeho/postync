/**
 * C8.3 — provider TikTok : conformité au Login Kit Web + OAuth v2 officiels
 * (URL d'autorisation à scopes en VIRGULES, échange, rotation du refresh
 * token, révocation, identité open_id). `fetch` simulé : aucun appel réseau,
 * aucun identifiant réel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TIKTOK_SCOPES,
  isTikTokConfigured,
  tiktokProvider,
} from "@/server/social/providers/tiktok";

const REDIRECT = "https://postync.vercel.app/api/oauth/tiktok/callback";

beforeEach(() => {
  process.env.TIKTOK_CLIENT_KEY = "test-client-key";
  process.env.TIKTOK_CLIENT_SECRET = "test-client-secret";
});

afterEach(() => {
  delete process.env.TIKTOK_CLIENT_KEY;
  delete process.env.TIKTOK_CLIENT_SECRET;
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("provider proposé uniquement si client_key ET client_secret sont présents", () => {
    expect(isTikTokConfigured()).toBe(true);
    delete process.env.TIKTOK_CLIENT_SECRET;
    expect(isTikTokConfigured()).toBe(false);
  });
});

describe("URL d'autorisation (Login Kit Web officiel)", () => {
  it("endpoint v2, client_key, scopes en virgules, code flow, state — sans PKCE ni secret", () => {
    const url = new URL(
      tiktokProvider.buildAuthUrl({ state: "state-opaque", codeChallenge: null, redirectUri: REDIRECT }),
    );
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("client_key")).toBe("test-client-key");
    // Séparateur VIRGULE — spécificité TikTok, un espace ou un « + » y échoue.
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.publish");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("state-opaque");
    // PKCE « mobile et desktop uniquement » selon la doc : pas en web.
    expect(tiktokProvider.usesPkce).toBe(false);
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.toString()).not.toContain("test-client-secret");
  });

  it("demande l'identité ET la publication, et rien d'autre", () => {
    // `video.publish` accompagne l'identité depuis l'ouverture du chantier
    // Content Posting API : le demander à la connexion évite un second
    // passage par le consentement, et `publish.ts` réclame de toute façon une
    // reconnexion aux comptes qui ne le portent pas.
    //
    // La borne HAUTE compte autant que la basse : `video.upload` ne publie
    // pas, `user.info.profile` et `video.list` ne servent à rien ici. Une
    // permission demandée sans usage est une permission de trop — et TikTok
    // exige que chaque scope soumis soit démontré en vidéo à l'App Review.
    expect(TIKTOK_SCOPES).toEqual(["user.info.basic", "video.publish"]);
  });
});

describe("échange de code et refresh", () => {
  const tokenPayload = {
    access_token: "act.tk-123",
    expires_in: 86400,
    refresh_token: "rft.tk-456",
    refresh_expires_in: 31536000,
    open_id: "open-id-001",
    scope: "user.info.basic",
    token_type: "Bearer",
  };

  it("échange : POST form v2/oauth/token avec client_key+client_secret ; durées 24 h / 365 j", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(tokenPayload), { status: 200 }),
    );
    const tokens = await tiktokProvider.exchangeCode({
      code: "auth-code",
      codeVerifier: null,
      redirectUri: REDIRECT,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("client_key")).toBe("test-client-key");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe(REDIRECT);

    expect(tokens.accessToken).toBe("act.tk-123");
    expect(tokens.refreshToken).toBe("rft.tk-456");
    expect(tokens.scopes).toEqual(["user.info.basic"]);
    const day = 24 * 3600 * 1000;
    expect(new Date(tokens.expiresAt!).getTime() - Date.now()).toBeGreaterThan(day - 60_000);
    expect(new Date(tokens.refreshExpiresAt!).getTime() - Date.now()).toBeGreaterThan(364 * day);
  });

  it("échange en échec : erreur avec code court, sans fuite du corps", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "detail-interne", log_id: "x" }),
        { status: 400 },
      ),
    );
    await expect(
      tiktokProvider.exchangeCode({ code: "bad", codeVerifier: null, redirectUri: REDIRECT }),
    ).rejects.toThrow("tiktok token: invalid_grant");
    // Ni le libellé de TikTok, ni le log_id ne remontent.
    await expect(
      tiktokProvider.exchangeCode({ code: "bad", codeVerifier: null, redirectUri: REDIRECT }),
    ).rejects.not.toThrow("detail-interne");
  });

  it("échec annoncé en HTTP 200 : détecté quand même (panne réelle du 2026-08-27)", async () => {
    // TikTok refuse la paire client_key/client_secret avec un statut 200 et un
    // champ `error`. Ne tester que `response.ok` laissait passer l'erreur, qui
    // ne se voyait ensuite que par un access_token manquant — le symptôme, pas
    // la cause. Le E2E réel a coûté un aller-retour complet à cause de ça.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_client",
          error_description: "Client key or secret is incorrect.",
          log_id: "2026082714144789146F7F13667D73D5C8",
        }),
        { status: 200 },
      ),
    );
    await expect(
      tiktokProvider.exchangeCode({ code: "bon", codeVerifier: null, redirectUri: REDIRECT }),
    ).rejects.toThrow("tiktok token: invalid_client");
  });

  it("refresh refusé en HTTP 200 : remonté comme invalid_grant, donc traité en révocation", async () => {
    // C'est ce code qui décide, dans token.ts, si le compte passe en « révoqué »
    // (reconnexion nécessaire) plutôt qu'en simple « erreur » passagère.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 200 }),
    );
    await expect(tiktokProvider.refresh!("rft.perime")).rejects.toThrow(
      "tiktok refresh: invalid_grant",
    );
  });

  it("refresh — ROTATION : le nouveau refresh_token remplace l'ancien", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ...tokenPayload, access_token: "act.tk-new", refresh_token: "rft.tk-ROTATED" }),
        { status: 200 },
      ),
    );
    const tokens = await tiktokProvider.refresh!("rft.tk-456");
    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rft.tk-456");
    expect(tokens.accessToken).toBe("act.tk-new");
    // La doc impose d'adopter le nouveau token s'il diffère : le TokenSet le porte.
    expect(tokens.refreshToken).toBe("rft.tk-ROTATED");
  });
});

describe("identité (user/info)", () => {
  it("GET v2/user/info avec Bearer et fields ; providerAccountId = open_id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            user: {
              open_id: "open-id-001",
              union_id: "union-1",
              display_name: "Ludovic TikTok",
              avatar_url_100: "https://tt.example/avatar100.jpg",
            },
          },
          error: { code: "ok", message: "" },
        }),
        { status: 200 },
      ),
    );
    const identity = await tiktokProvider.fetchIdentity!("act.tk-123");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://open.tiktokapis.com/v2/user/info/");
    expect(url.searchParams.get("fields")).toBe("open_id,union_id,display_name,avatar_url_100");
    expect(identity).toEqual({
      providerAccountId: "open-id-001",
      displayName: "Ludovic TikTok",
      avatarUrl: "https://tt.example/avatar100.jpg",
    });
  });

  it("erreur métier TikTok (error.code ≠ ok) : rejetée avec le code seul", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: {}, error: { code: "access_token_invalid", message: "detail" } }),
        { status: 200 },
      ),
    );
    await expect(tiktokProvider.fetchIdentity!("bad")).rejects.toThrow(
      "tiktok user/info: access_token_invalid",
    );
  });
});

describe("révocation", () => {
  it("POST v2/oauth/revoke avec l'access token et les identifiants client", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await tiktokProvider.revoke!({ accessToken: "act.tk-123", refreshToken: "rft.tk-456" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://open.tiktokapis.com/v2/oauth/revoke/");
    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.get("token")).toBe("act.tk-123");
    expect(body.get("client_key")).toBe("test-client-key");
  });

  it("corps vide : succès, pas une erreur", async () => {
    // La doc annonce une réponse SANS corps en cas de succès — un JSON illisible
    // ne doit donc pas être pris pour un échec.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await expect(
      tiktokProvider.revoke!({ accessToken: "act.tk-123", refreshToken: null }),
    ).resolves.toBeUndefined();
  });

  it("révocation refusée : l'échec est REMONTÉ, pas avalé", async () => {
    // La déconnexion locale reste prioritaire et non bloquante, mais l'appelant
    // doit pouvoir journaliser qu'une autorisation reste vivante côté TikTok.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_client" }), { status: 200 }),
    );
    await expect(
      tiktokProvider.revoke!({ accessToken: "act.tk-123", refreshToken: null }),
    ).rejects.toThrow("tiktok revoke: invalid_client");
  });
});
