/**
 * Séparation du site public et de l'application (C18).
 *
 * Ce que ces tests protègent réellement : les deux domaines sont servis par le
 * MÊME déploiement, donc rien dans l'infrastructure n'empêche une erreur de
 * classement. Une seule règle mal écrite et l'on obtient soit un formulaire de
 * connexion servi par le domaine public — session posée sur le mauvais hôte —,
 * soit, bien pire, un `redirect_uri` OAuth redirigé et les quatre intégrations
 * sociales cassées d'un coup.
 */
import { describe, expect, it } from "vitest";

import {
  APP_HOST,
  APP_ORIGIN,
  LEGAL_PATHS,
  PUBLIC_HOST,
  PUBLIC_ORIGIN,
  PUBLIC_PATHS,
  isLegalPath,
  isPublicPath,
} from "@/config/domains";

describe("domaines publics", () => {
  it("A1 — les deux origines sont distinctes et en HTTPS", () => {
    expect(PUBLIC_ORIGIN).toBe(`https://${PUBLIC_HOST}`);
    expect(APP_ORIGIN).toBe(`https://${APP_HOST}`);
    expect(PUBLIC_HOST).not.toBe(APP_HOST);
  });

  it("A2 — les documents légaux sont tous des pages publiques", () => {
    // L'inverse laisserait une page légale renvoyée vers l'application, donc
    // derrière une authentification : une politique de confidentialité qu'on
    // ne peut lire qu'en étant client ne remplit pas son office.
    for (const chemin of LEGAL_PATHS) {
      expect(PUBLIC_PATHS).toContain(chemin);
    }
  });

  it("A3 — les chemins publics sont reconnus, avec ou sans barre finale", () => {
    for (const chemin of PUBLIC_PATHS) {
      expect(isPublicPath(chemin)).toBe(true);
    }
    expect(isPublicPath("/privacy/")).toBe(true);
    expect(isLegalPath("/terms/")).toBe(true);
    expect(isPublicPath("/")).toBe(true);
  });

  it("A4 — la correspondance est EXACTE, jamais par préfixe", () => {
    // `/legal` est public ; `/legalxyz` ne l'est pas. Une règle par préfixe
    // ouvrirait le domaine public à des routes non prévues.
    expect(isPublicPath("/legalxyz")).toBe(false);
    expect(isPublicPath("/privacy/export")).toBe(false);
    expect(isLegalPath("/terms-of-sale")).toBe(false);
  });

  it("A5 — LE test qui compte : rien de l'application n'est public", () => {
    // Si l'un de ces chemins passait pour public, il serait servi par
    // `postync.app`. Pour `/api/oauth/...`, cela signifierait un callback
    // atteignable sur un domaine que Meta, TikTok et Google n'autorisent pas.
    const application = [
      "/login",
      "/signup",
      "/forgot-password",
      "/reset-password",
      "/onboarding",
      "/app",
      "/app/test/accounts",
      "/admin",
      "/auth/callback",
      "/api/oauth/instagram/callback",
      "/api/oauth/facebook/callback",
      "/api/oauth/tiktok/callback",
      "/api/oauth/youtube/callback",
      "/api/stripe/webhook",
      "/api/cron/publish",
      "/invitations/jeton",
    ];
    for (const chemin of application) {
      expect(isPublicPath(chemin), `${chemin} ne doit pas être public`).toBe(false);
      expect(isLegalPath(chemin), `${chemin} n'est pas un document légal`).toBe(false);
    }
  });
});
