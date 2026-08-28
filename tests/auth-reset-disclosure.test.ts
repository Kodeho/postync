import { describe, expect, it } from "vitest";

import { shouldDiscloseResetError } from "@/features/auth/reset-disclosure";
import {
  validateEmailOnly,
  validateNewPassword,
  validatePasswordChange,
  PASSWORD_MIN_LENGTH,
} from "@/features/auth/validation";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.append(k, v);
  return data;
}

/**
 * C15 — ce qu'une demande de réinitialisation laisse filtrer.
 *
 * Le formulaire « mot de passe oublié » est PUBLIC. S'il répondait
 * différemment selon que l'adresse existe ou non, il deviendrait un moyen
 * d'énumérer la clientèle de POSTYNC, une adresse à la fois.
 *
 * La liste ci-dessous est donc écrite à l'envers de l'habitude : elle
 * énumère ce qui NE DOIT PAS sortir. Un code ajouté par mégarde à la règle
 * de divulgation fera échouer ce test.
 */
describe("divulgation d'une erreur de réinitialisation", () => {
  it("ne révèle rien de ce qui dépend de l'adresse saisie", () => {
    for (const code of [
      "user_not_found",
      "email_address_invalid",
      "email_address_not_authorized",
      "email_not_confirmed",
      "user_banned",
      "validation_failed",
      "unexpected_failure",
      "",
      null,
      undefined,
    ]) {
      expect(shouldDiscloseResetError(code)).toBe(false);
    }
  });

  it("dit en revanche les limites de débit, qui ne dépendent pas de l'adresse", () => {
    // Les taire coûterait quelque chose de réel : la personne attendrait un
    // courriel que Supabase a refusé d'envoyer, puis recommencerait.
    expect(shouldDiscloseResetError("over_email_send_rate_limit")).toBe(true);
    expect(shouldDiscloseResetError("over_request_rate_limit")).toBe(true);
  });
});

describe("validation de la demande", () => {
  it("s'arrête à la forme de l'adresse, jamais à son existence", () => {
    expect(validateEmailOnly(form({ email: "  Jean@Exemple.FR " }))).toEqual({
      ok: true,
      value: "jean@exemple.fr",
    });
    expect(validateEmailOnly(form({ email: "jean@exemple" })).ok).toBe(false);
    expect(validateEmailOnly(form({})).ok).toBe(false);
  });
});

describe("validation du nouveau mot de passe", () => {
  it("applique les mêmes exigences qu'à l'inscription", () => {
    const court = "a".repeat(PASSWORD_MIN_LENGTH - 1);
    expect(
      validateNewPassword(form({ password: court, confirmPassword: court })).ok,
    ).toBe(false);
  });

  it("refuse deux saisies différentes", () => {
    const resultat = validateNewPassword(
      form({ password: "motdepasse-solide", confirmPassword: "motdepasse-solidr" }),
    );
    expect(resultat.ok).toBe(false);
  });

  it("accepte une saisie valide et cohérente", () => {
    expect(
      validateNewPassword(
        form({ password: "motdepasse-solide", confirmPassword: "motdepasse-solide" }),
      ),
    ).toEqual({ ok: true, value: { password: "motdepasse-solide" } });
  });
});

describe("changement de mot de passe en étant connecté", () => {
  const solide = "motdepasse-solide";

  it("exige le mot de passe actuel", () => {
    // Sans lui, une session laissée ouverte sur un poste partagé suffirait à
    // s'approprier définitivement le compte.
    const resultat = validatePasswordChange(
      form({ password: solide, confirmPassword: solide }),
    );
    expect(resultat).toEqual({
      ok: false,
      error: "Veuillez saisir votre mot de passe actuel.",
    });
  });

  it("refuse de remplacer un mot de passe par lui-même", () => {
    const resultat = validatePasswordChange(
      form({ currentPassword: solide, password: solide, confirmPassword: solide }),
    );
    expect(resultat.ok).toBe(false);
  });

  it("applique les mêmes exigences de longueur qu'ailleurs", () => {
    const court = "a".repeat(PASSWORD_MIN_LENGTH - 1);
    const resultat = validatePasswordChange(
      form({ currentPassword: "ancien-mot-de-passe", password: court, confirmPassword: court }),
    );
    expect(resultat.ok).toBe(false);
  });

  it("accepte un changement complet et cohérent", () => {
    expect(
      validatePasswordChange(
        form({ currentPassword: "ancien-mot-de-passe", password: solide, confirmPassword: solide }),
      ),
    ).toEqual({
      ok: true,
      value: { currentPassword: "ancien-mot-de-passe", password: solide },
    });
  });
});
