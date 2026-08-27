/**
 * C8.4a — provider Instagram : conformité à « Instagram API with Instagram
 * Login » (Business Login for Instagram) tel que documenté officiellement par
 * Meta. `fetch` simulé : aucun appel réseau, aucun identifiant réel.
 *
 * Points officiels couverts, parce qu'ils sont contre-intuitifs :
 *   - le code d'autorisation revient avec `#_` accolé, à retirer ;
 *   - les réponses sont enveloppées dans un tableau `data` ;
 *   - le token de l'échange ne vaut qu'1 heure : il DOIT être converti en
 *     token longue durée dans la foulée ;
 *   - il n'existe AUCUN refresh token distinct, ni AUCUN endpoint de
 *     révocation pour cette configuration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INSTAGRAM_REVOKE_NOTICE,
  INSTAGRAM_SCOPES,
  instagramProvider,
  isInstagramConfigured,
  stripCodeFragment,
} from "@/server/social/providers/instagram";

const REDIRECT = "https://postync.vercel.app/api/oauth/instagram/callback";
const SIXTY_DAYS = 5_183_944; // valeur d'exemple de la documentation Meta

/**
 * Réponses successives de `fetch`, dans l'ordre des appels. Une fois la
 * séquence épuisée, tout appel supplémentaire ÉCHOUE bruyamment : un test ne
 * doit jamais retomber sur le vrai réseau.
 */
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  process.env.INSTAGRAM_APP_ID = "test-ig-app-id";
  process.env.INSTAGRAM_APP_SECRET = "test-ig-app-secret";
});

afterEach(() => {
  delete process.env.INSTAGRAM_APP_ID;
  delete process.env.INSTAGRAM_APP_SECRET;
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("provider proposé uniquement si l'Instagram App ID ET le secret sont présents", () => {
    expect(isInstagramConfigured()).toBe(true);
    delete process.env.INSTAGRAM_APP_SECRET;
    expect(isInstagramConfigured()).toBe(false);
  });

  it("identifiants Instagram dédiés : META_CLIENT_* ne doit PAS être utilisé", () => {
    delete process.env.INSTAGRAM_APP_ID;
    delete process.env.INSTAGRAM_APP_SECRET;
    process.env.META_CLIENT_ID = "fb-app-id";
    process.env.META_CLIENT_SECRET = "fb-app-secret";
    // L'App ID Facebook n'est pas l'App ID Instagram : aucun repli silencieux.
    expect(isInstagramConfigured()).toBe(false);
    delete process.env.META_CLIENT_ID;
    delete process.env.META_CLIENT_SECRET;
  });
});

describe("URL d'autorisation (Business Login officiel)", () => {
  it("endpoint instagram.com, client_id, scopes en virgules, state — sans PKCE ni secret", () => {
    const url = new URL(
      instagramProvider.buildAuthUrl({
        state: "state-opaque",
        codeChallenge: null,
        redirectUri: REDIRECT,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-ig-app-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("state-opaque");
    // Séparateur VIRGULE, comme la documentation Business Login.
    // Identité + publication demandées en une fois : un compte connecté ne
    // doit pas repasser par le consentement au moment de publier.
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_content_publish",
    );
    // Aucun PKCE documenté pour ce flux : le state à usage unique couvre le CSRF.
    expect(instagramProvider.usesPkce).toBe(false);
    expect(url.searchParams.get("code_challenge")).toBeNull();
    // Le secret ne doit jamais partir vers le navigateur.
    expect(url.toString()).not.toContain("test-ig-app-secret");
  });

  it("scopes limités à l'identité et à la publication — rien de plus", () => {
    expect(INSTAGRAM_SCOPES).toEqual([
      "instagram_business_basic",
      "instagram_business_content_publish",
    ]);
    // Moindre privilège : ni messagerie, ni commentaires.
    expect(INSTAGRAM_SCOPES).not.toContain("instagram_business_manage_messages");
    expect(INSTAGRAM_SCOPES).not.toContain("instagram_business_manage_comments");
  });
});

describe("code d'autorisation : suffixe `#_` documenté par Meta", () => {
  it("le fragment est retiré avant tout usage", () => {
    expect(stripCodeFragment("abcdefghijklmnopqrstuvwxyz#_")).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(stripCodeFragment("code-sans-fragment")).toBe("code-sans-fragment");
    expect(stripCodeFragment("code#autre")).toBe("code");
  });
});

describe("échange de code", () => {
  const shortLived = { data: [{ access_token: "IGAA.short", user_id: "17841400000000000", permissions: "instagram_business_basic" }] };
  const longLived = { access_token: "IGAA.long", token_type: "bearer", expires_in: SIXTY_DAYS };

  it("POST api.instagram.com puis CONVERSION longue durée : le token court n'est jamais conservé", async () => {
    const fetchMock = mockFetchSequence(json(shortLived), json(longLived));

    const tokens = await instagramProvider.exchangeCode({
      code: "auth-code#_",
      codeVerifier: null,
      redirectUri: REDIRECT,
    });

    // 1er appel : échange du code.
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(String(tokenUrl)).toBe("https://api.instagram.com/oauth/access_token");
    expect(tokenInit?.method).toBe("POST");
    const body = new URLSearchParams(String(tokenInit?.body));
    expect(body.get("client_id")).toBe("test-ig-app-id");
    expect(body.get("client_secret")).toBe("test-ig-app-secret");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe(REDIRECT);
    // Le `#_` a bien été retiré.
    expect(body.get("code")).toBe("auth-code");

    // 2e appel : ig_exchange_token, sans quoi le jeton expirerait en 1 heure.
    const longUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(longUrl.origin + longUrl.pathname).toBe("https://graph.instagram.com/access_token");
    expect(longUrl.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(longUrl.searchParams.get("client_secret")).toBe("test-ig-app-secret");
    expect(longUrl.searchParams.get("access_token")).toBe("IGAA.short");

    // Seul le token longue durée ressort.
    expect(tokens.accessToken).toBe("IGAA.long");
    expect(tokens.accessToken).not.toBe("IGAA.short");
  });

  it("aucun refresh token distinct ; expiration ≈ 60 jours et refresh borné à la même date", async () => {
    mockFetchSequence(json(shortLived), json(longLived));
    const tokens = await instagramProvider.exchangeCode({
      code: "auth-code",
      codeVerifier: null,
      redirectUri: REDIRECT,
    });

    // Instagram ne délivre pas de refresh token : ne rien inventer.
    expect(tokens.refreshToken).toBeNull();
    const day = 24 * 3600 * 1000;
    const remaining = new Date(tokens.expiresAt!).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(59 * day);
    expect(remaining).toBeLessThan(61 * day);
    // Passé l'expiration du token, plus aucun rafraîchissement possible.
    expect(tokens.refreshExpiresAt).toBe(tokens.expiresAt);
  });

  it("les scopes retenus sont ceux RÉELLEMENT accordés par l'utilisateur", async () => {
    mockFetchSequence(
      json({ data: [{ access_token: "IGAA.short", user_id: "1", permissions: "instagram_business_basic,instagram_business_manage_comments" }] }),
      json(longLived),
    );
    const tokens = await instagramProvider.exchangeCode({
      code: "c",
      codeVerifier: null,
      redirectUri: REDIRECT,
    });
    expect(tokens.scopes).toEqual([
      "instagram_business_basic",
      "instagram_business_manage_comments",
    ]);
  });

  it("permissions renvoyées en TABLEAU : forme réellement observée de l'API", async () => {
    // La doc Meta montre une chaîne « a,b,c » ; l'API renvoie un tableau.
    // Constaté en E2E réel le 2026-08-27 — se fier à la doc cassait la connexion.
    mockFetchSequence(
      json({
        data: [
          {
            access_token: "IGAA.short",
            user_id: "1",
            permissions: ["instagram_business_basic", "instagram_business_content_publish"],
          },
        ],
      }),
      json(longLived),
    );
    const tokens = await instagramProvider.exchangeCode({
      code: "c",
      codeVerifier: null,
      redirectUri: REDIRECT,
    });
    expect(tokens.scopes).toEqual([
      "instagram_business_basic",
      "instagram_business_content_publish",
    ]);
  });

  it("permissions absentes ou vides : repli sur les scopes demandés", async () => {
    mockFetchSequence(
      json({ data: [{ access_token: "IGAA.short", user_id: "1", permissions: [] }] }),
      json(longLived),
    );
    const tokens = await instagramProvider.exchangeCode({
      code: "c",
      codeVerifier: null,
      redirectUri: REDIRECT,
    });
    expect(tokens.scopes).toEqual(INSTAGRAM_SCOPES);
  });

  it("réponse à plat (hors enveloppe `data`) également acceptée", async () => {
    mockFetchSequence(
      json({ access_token: "IGAA.short", user_id: "1" }),
      json(longLived),
    );
    const tokens = await instagramProvider.exchangeCode({
      code: "c",
      codeVerifier: null,
      redirectUri: REDIRECT,
    });
    expect(tokens.accessToken).toBe("IGAA.long");
  });

  it("échec : code court d'erreur, sans fuite du message Meta ni du token", async () => {
    mockFetchSequence(
      json(
        {
          error: {
            type: "OAuthException",
            code: 100,
            error_subcode: 33,
            message: "detail-interne-avec-identifiant",
          },
        },
        400,
      ),
    );
    const error = await instagramProvider
      .exchangeCode({ code: "bad", codeVerifier: null, redirectUri: REDIRECT })
      .then(() => null)
      .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));

    expect(error?.message).toBe("instagram token: HTTP 400 OAuthException/100/33");
    // Le message brut de Meta ne doit pas se retrouver dans nos logs.
    expect(error?.message).not.toContain("detail-interne");
  });
});

describe("identité (graph.instagram.com/me)", () => {
  it("providerAccountId = user_id ; username en nom affiché ; enveloppe `data`", async () => {
    const fetchMock = mockFetchSequence(
      json({
        data: [
          {
            user_id: "17841400000000000",
            username: "postync.studio",
            name: "POSTYNC Studio",
            account_type: "BUSINESS",
            profile_picture_url: "https://ig.example/avatar.jpg",
          },
        ],
      }),
    );

    const identity = await instagramProvider.fetchIdentity!("IGAA.long");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    // Version d'API épinglée : un appel non versionné suivrait les bascules
    // de Meta sans prévenir.
    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/v25.0/me");
    expect(url.searchParams.get("fields")).toContain("user_id");
    expect(identity).toEqual({
      providerAccountId: "17841400000000000",
      displayName: "postync.studio",
      avatarUrl: "https://ig.example/avatar.jpg",
    });
  });

  it("champ non supporté (HTTP 400) : repli sur les champs documentés, la connexion aboutit", async () => {
    const fetchMock = mockFetchSequence(
      json({ error: { type: "OAuthException", code: 100 } }, 400),
      json({ data: [{ user_id: "42", username: "compte.minimal" }] }),
    );

    const identity = await instagramProvider.fetchIdentity!("IGAA.long");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Le 2e appel ne demande que le jeu strictement documenté.
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("fields")).toBe(
      "user_id,username",
    );
    expect(identity).toEqual({
      providerAccountId: "42",
      displayName: "compte.minimal",
      avatarUrl: null,
    });
  });

  it("user_id numérique converti en chaîne (clé d'unicité de social_accounts)", async () => {
    mockFetchSequence(json({ data: [{ user_id: 17841400000000000, username: "n" }] }));
    const identity = await instagramProvider.fetchIdentity!("IGAA.long");
    expect(typeof identity.providerAccountId).toBe("string");
  });

  it("réponse sans user_id : rejetée plutôt que d'enregistrer un compte anonyme", async () => {
    mockFetchSequence(json({ data: [{ username: "sans-id" }] }));
    await expect(instagramProvider.fetchIdentity!("IGAA.long")).rejects.toThrow(
      "instagram me: user_id absent",
    );
  });
});

describe("rafraîchissement (ig_refresh_token)", () => {
  it("appelé avec l'ACCESS TOKEN courant — Instagram n'a pas de refresh token", async () => {
    // Le drapeau prévient l'appelant : lire access_token_id, pas refresh_token_id.
    expect(instagramProvider.refreshUsesAccessToken).toBe(true);

    const fetchMock = mockFetchSequence(
      json({ access_token: "IGAA.renewed", token_type: "bearer", expires_in: SIXTY_DAYS }),
    );
    const tokens = await instagramProvider.refresh!("IGAA.long");

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(url.searchParams.get("access_token")).toBe("IGAA.long");
    // Le secret n'intervient PAS dans le rafraîchissement (contrairement à l'échange).
    expect(url.searchParams.get("client_secret")).toBeNull();

    expect(tokens.accessToken).toBe("IGAA.renewed");
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.refreshExpiresAt).toBe(tokens.expiresAt);
  });

  it("échec : code court, sans fuite du token dans le message", async () => {
    mockFetchSequence(json({ error: { type: "OAuthException", code: 190 } }, 400));
    await expect(instagramProvider.refresh!("IGAA.long")).rejects.toThrow(
      "instagram refresh: HTTP 400 OAuthException/190",
    );
  });
});

describe("révocation", () => {
  it("aucune révocation implémentée : Meta n'en documente pas pour cette configuration", () => {
    // Ne pas appeler d'endpoint non documenté, et ne pas prétendre révoquer.
    expect(instagramProvider.revoke).toBeUndefined();
  });

  it("une notice explique à l'utilisateur comment retirer l'autorisation lui-même", () => {
    expect(instagramProvider.revokeNotice).toBe(INSTAGRAM_REVOKE_NOTICE);
    expect(INSTAGRAM_REVOKE_NOTICE).toMatch(/Instagram/);
  });
});
