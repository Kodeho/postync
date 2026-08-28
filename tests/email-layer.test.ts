import { describe, expect, it } from "vitest";

import {
  classifyHttpStatus,
  classifyThrown,
  isRetryable,
  type EmailFailureCode,
} from "@/server/email/failure";
import { escapeHtml, renderEmail, renderText } from "@/server/email/templates/layout";
import { buildInvitationEmail } from "@/server/email/templates/invitation";
import { buildPasswordChangedEmail } from "@/server/email/templates/security";

/**
 * Couche d'envoi de courriels — règles pures.
 *
 * Ce fichier ne touche ni au réseau ni à la base : il vérifie les décisions
 * qui, prises de travers, coûtent soit un courriel perdu, soit un courriel
 * envoyé deux fois.
 */

describe("classification des échecs", () => {
  it("ne réessaie que ce qui ne dépend pas de ce qu'on a envoyé", () => {
    // Passagers : la même requête peut réussir la seconde fois.
    for (const code of ["network", "timeout", "provider_unavailable", "rate_limited"] as const) {
      expect(isRetryable(code)).toBe(true);
    }

    // Définitifs. Réessayer ne les répare pas : cela retarde le message
    // d'erreur, consomme le quota, et peut expédier deux fois si la première
    // tentative avait en réalité abouti.
    for (const code of ["unauthorized", "rejected", "unknown"] as const) {
      expect(isRetryable(code)).toBe(false);
    }
  });

  it("traduit les statuts HTTP de Scaleway", () => {
    const cas: Array<[number, EmailFailureCode]> = [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [429, "rate_limited"],
      [500, "provider_unavailable"],
      [503, "provider_unavailable"],
      [400, "rejected"],
      [422, "rejected"],
    ];
    for (const [status, attendu] of cas) {
      expect(classifyHttpStatus(status)).toBe(attendu);
    }
  });

  it("une clé invalide n'est JAMAIS réessayée", () => {
    // Elle le restera à la milliseconde suivante ; insister ne ferait que
    // retarder le diagnostic.
    expect(isRetryable(classifyHttpStatus(401))).toBe(false);
    expect(isRetryable(classifyHttpStatus(403))).toBe(false);
  });

  it("distingue un délai dépassé d'une coupure réseau", () => {
    const timeout = new Error("délai");
    timeout.name = "TimeoutError";
    expect(classifyThrown(timeout)).toBe("timeout");

    const abort = new Error("annulé");
    abort.name = "AbortError";
    expect(classifyThrown(abort)).toBe("timeout");

    expect(classifyThrown(new TypeError("fetch failed"))).toBe("network");
    expect(classifyThrown("chaîne quelconque")).toBe("unknown");
  });
});

describe("coquille des messages", () => {
  const blocks = [
    { kind: "paragraph" as const, text: "Bonjour" },
    { kind: "button" as const, label: "Agir", href: "https://exemple.test/x" },
  ];

  it("échappe le HTML des valeurs venues de la base", () => {
    // Un workspace peut s'appeler n'importe comment : c'est une saisie.
    expect(escapeHtml('<script>"x"</script>')).toBe(
      "&lt;script&gt;&quot;x&quot;&lt;/script&gt;",
    );
    const html = renderEmail({ title: "<b>Titre</b>", blocks });
    expect(html).not.toContain("<b>Titre</b>");
    expect(html).toContain("&lt;b&gt;Titre&lt;/b&gt;");
  });

  it("produit un HTML que les clients de messagerie savent rendre", () => {
    const html = renderEmail({ title: "Titre", blocks });
    // Tableaux et styles en ligne : Outlook rend le HTML avec le moteur de
    // Word, et Gmail retire les feuilles de style de l'en-tête.
    expect(html).toContain("<table");
    expect(html).toContain("style=");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("flex");
    // Aucune ressource distante : les images sont bloquées par défaut.
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<link[^>]+href/);
    // Largeur plafonnée : la valeur qu'acceptent tous les clients.
    expect(html).toContain("max-width:600px");
  });

  it("fournit toujours une version texte, construite des mêmes blocs", () => {
    const text = renderText({ title: "Titre", blocks });
    expect(text).toContain("Titre");
    expect(text).toContain("Bonjour");
    // Le lien du bouton doit rester atteignable en texte brut.
    expect(text).toContain("https://exemple.test/x");
    expect(text).not.toContain("<");
  });
});

describe("gabarit d'invitation", () => {
  const base = {
    workspaceName: "Studio Kodeho",
    role: "member",
    invitationUrl: "https://postync.example/invitations/JETON",
    expiresAt: "2026-09-04T10:00:00.000Z",
  };

  it("nomme le workspace, le rôle et l'échéance", () => {
    const message = buildInvitationEmail({ ...base, invitedByName: "Ludovic" });
    expect(message.subject).toContain("Studio Kodeho");
    expect(message.html).toContain("Ludovic");
    expect(message.html).toContain("Member");
    expect(message.text).toContain("4 septembre 2026");
  });

  it("dit que le lien ne vaut que pour l'adresse destinataire", () => {
    // Règle de sécurité de C14 : la dire évite qu'on transfère le message.
    const message = buildInvitationEmail({ ...base, invitedByName: null });
    expect(message.text).toContain("adresse à laquelle cet e-mail a été envoyé");
  });

  it("se passe du nom de l'invitant quand POSTYNC ne le connaît pas", () => {
    const message = buildInvitationEmail({ ...base, invitedByName: null });
    expect(message.html).not.toContain("null");
    expect(message.html).toContain("Vous êtes invité");
  });

  it("place le lien dans les deux versions", () => {
    const message = buildInvitationEmail({ ...base, invitedByName: null });
    expect(message.html).toContain(base.invitationUrl);
    expect(message.text).toContain(base.invitationUrl);
  });
});

describe("gabarit de notification de sécurité", () => {
  const base = { occurredAtIso: "2026-08-28T12:00:00.000Z", timeZone: "Europe/Paris" };

  it("ne contient AUCUN lien d'action", () => {
    // Un courriel d'alerte porteur d'un lien est exactement ce que
    // reproduisent les tentatives d'hameçonnage : POSTYNC ne peut pas
    // apprendre à ses clients à cliquer dans ce genre de message.
    for (const origin of ["reset", "settings"] as const) {
      const message = buildPasswordChangedEmail({ ...base, origin });
      expect(message.html).not.toContain("href=");
      expect(message.text).not.toContain("http");
    }
  });

  it("distingue l'origine du changement", () => {
    expect(buildPasswordChangedEmail({ ...base, origin: "reset" }).text).toContain(
      "lien de réinitialisation",
    );
    expect(buildPasswordChangedEmail({ ...base, origin: "settings" }).text).toContain(
      "paramètres de votre compte",
    );
  });

  it("date l'événement dans le fuseau demandé", () => {
    const paris = buildPasswordChangedEmail({ ...base, origin: "settings" }).text;
    const montreal = buildPasswordChangedEmail({
      ...base,
      origin: "settings",
      timeZone: "America/Montreal",
    }).text;
    expect(paris).not.toBe(montreal);
    expect(paris).toContain("14:00");
    expect(montreal).toContain("08:00");
  });
});
