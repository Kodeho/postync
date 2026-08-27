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
  /** Raccourci : un compte actif décrit par ses seules dates et sa capacité de refresh. */
  const compte = (
    token: string | null,
    refresh: string | null,
    canRefresh: boolean,
  ) => ({
    status: "active" as const,
    token_expires_at: token,
    refresh_expires_at: refresh,
    can_refresh: canRefresh,
  });

  it("jeton valide -> Connecté", () => {
    expect(effectiveStatus(compte(FUTURE, null, false), NOW)).toBe("active");
  });

  it("YOUTUBE — jeton d'une heure expiré MAIS refresh token disponible -> Connecté", () => {
    // Le cas qui a motivé la correction : Google ne date pas l'expiration du
    // refresh token (`refresh_expires_at` null), et l'access token ne dure
    // qu'une heure. Raisonner sur les seules dates faisait passer le compte
    // pour mort dès la 61e minute.
    expect(effectiveStatus(compte(PAST, null, true), NOW)).toBe("active");
  });

  it("jeton expiré SANS aucun moyen de rafraîchir -> Expiré (reconnexion)", () => {
    expect(effectiveStatus(compte(PAST, null, false), NOW)).toBe("expired");
  });

  it("jeton expiré avec refresh encore valide et daté -> Connecté", () => {
    expect(effectiveStatus(compte(PAST, FUTURE, true), NOW)).toBe("active");
  });

  it("refresh token expiré (TikTok, 365 j) -> Expiré même si can_refresh", () => {
    // Le refresh token existe encore en base mais il est périmé : la
    // possession d'un jeton ne vaut pas capacité à s'en servir.
    expect(effectiveStatus(compte(PAST, PAST, true), NOW)).toBe("expired");
  });

  it("INSTAGRAM — dates alignées, avant échéance -> Connecté", () => {
    // Instagram n'a pas de refresh token distinct (can_refresh false) : le
    // jeton se rafraîchit lui-même tant qu'il est valide.
    expect(effectiveStatus(compte(FUTURE, FUTURE, false), NOW)).toBe("active");
  });

  it("INSTAGRAM — dates alignées, après échéance -> Expiré", () => {
    expect(effectiveStatus(compte(PAST, PAST, false), NOW)).toBe("expired");
  });

  it("FACEBOOK — jeton de Page sans date d'expiration -> Connecté", () => {
    expect(effectiveStatus(compte(null, null, false), NOW)).toBe("active");
  });

  it("un statut non actif prime toujours sur les dates", () => {
    expect(
      effectiveStatus(
        { status: "revoked", token_expires_at: FUTURE, refresh_expires_at: null, can_refresh: true },
        NOW,
      ),
    ).toBe("revoked");
  });

  it("revoked / error : conservés tels quels ; reconnexion proposée", () => {
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
