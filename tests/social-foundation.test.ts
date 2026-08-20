/**
 * C8.1 — socle comptes sociaux : primitives PKCE/state (RFC 7636), statuts
 * effectifs, quotas. Logique pure.
 */
import { describe, expect, it } from "vitest";

import {
  PLATFORM_LABELS,
  SOCIAL_STATUS_LABELS,
  canConnectMore,
  effectiveStatus,
  needsReconnect,
} from "@/server/social/accounts";
import {
  codeChallengeS256,
  generateCodeVerifier,
  generateState,
  hashState,
} from "@/server/social/pkce";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const PAST = "2026-08-19T00:00:00.000Z";
const FUTURE = "2026-12-31T00:00:00.000Z";

describe("PKCE (RFC 7636)", () => {
  it("challenge S256 conforme au vecteur de test de la RFC (annexe B)", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("verifier : longueur 43-128, alphabet non réservé, unique", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a).not.toBe(b);
  });
});

describe("state OAuth", () => {
  it("valeur opaque 256 bits, hachage SHA-256 hexadécimal stable", () => {
    const state = generateState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashState(state)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashState(state)).toBe(hashState(state));
    expect(hashState(state)).not.toBe(hashState(generateState()));
  });
});

describe("statut effectif d'un compte", () => {
  it("active + jeton valide -> Connecté", () => {
    expect(
      effectiveStatus({ status: "active", token_expires_at: FUTURE, refresh_expires_at: null }, NOW),
    ).toBe("active");
  });

  it("active + jeton expiré SANS refresh -> Expiré (reconnexion)", () => {
    expect(
      effectiveStatus({ status: "active", token_expires_at: PAST, refresh_expires_at: null }, NOW),
    ).toBe("expired");
  });

  it("active + jeton expiré AVEC refresh encore valide -> Connecté (refresh à la demande)", () => {
    expect(
      effectiveStatus({ status: "active", token_expires_at: PAST, refresh_expires_at: FUTURE }, NOW),
    ).toBe("active");
  });

  it("refresh token expiré (TikTok 365 j) -> Expiré", () => {
    expect(
      effectiveStatus({ status: "active", token_expires_at: PAST, refresh_expires_at: PAST }, NOW),
    ).toBe("expired");
  });

  it("jeton non expirant (Page Meta) -> Connecté", () => {
    expect(
      effectiveStatus({ status: "active", token_expires_at: null, refresh_expires_at: null }, NOW),
    ).toBe("active");
  });

  it("revoked / error : conservés tels quels ; reconnexion proposée", () => {
    expect(
      effectiveStatus({ status: "revoked", token_expires_at: FUTURE, refresh_expires_at: null }, NOW),
    ).toBe("revoked");
    expect(needsReconnect("active")).toBe(false);
    expect(needsReconnect("expired")).toBe(true);
    expect(needsReconnect("revoked")).toBe(true);
    expect(needsReconnect("error")).toBe(true);
  });
});

describe("quota socialAccounts (plans C7)", () => {
  it("bloque à la limite du plan, tous réseaux confondus", () => {
    expect(canConnectMore(0, 2)).toBe(true); // Free : 2
    expect(canConnectMore(1, 2)).toBe(true);
    expect(canConnectMore(2, 2)).toBe(false);
    expect(canConnectMore(100, 100)).toBe(false); // Agency / Full Access
  });
});

describe("libellés", () => {
  it("quatre plateformes, quatre statuts", () => {
    expect(Object.keys(PLATFORM_LABELS)).toEqual(["instagram", "facebook", "tiktok", "youtube"]);
    expect(Object.keys(SOCIAL_STATUS_LABELS)).toEqual(["active", "expired", "revoked", "error"]);
  });
});
