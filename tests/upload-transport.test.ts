/**
 * Transport des octets vers le stockage.
 *
 * Ce qui est vérifié ici n'est pas le protocole TUS lui-même — c'est une
 * bibliothèque éprouvée, la retester serait tester `tus-js-client`. Ce sont
 * les DÉCISIONS de POSTYNC autour : quel transport pour quelle taille, quel
 * hôte, et surtout quel message l'utilisateur lit quand le stockage refuse.
 *
 * Ce dernier point est celui qui a coûté le plus cher : pendant des jours, un
 * refus de taille et une coupure réseau produisaient la même phrase
 * (« Le transfert a échoué. Réessayez »), ce qui a fait chercher un défaut de
 * l'application là où le stockage disait clairement la vérité.
 */
import { describe, expect, it } from "vitest";

import {
  ErreurTransport,
  SEUIL_REPRENABLE,
  hoteDeStockage,
  messageDeRefus,
} from "@/features/media/upload-transport";

describe("hoteDeStockage", () => {
  it("bascule sur l'hôte de stockage direct, recommandé pour les gros fichiers", () => {
    expect(hoteDeStockage("https://abcdefghijklmnop.supabase.co")).toBe(
      "https://abcdefghijklmnop.storage.supabase.co",
    );
  });

  it("tolère une barre oblique finale", () => {
    expect(hoteDeStockage("https://abcdefghijklmnop.supabase.co/")).toBe(
      "https://abcdefghijklmnop.storage.supabase.co",
    );
  });

  it("laisse intact un domaine personnalisé plutôt que d'inventer un hôte", () => {
    // Inventer `https://api.storage.exemple.fr` enverrait les octets dans le
    // vide. Un transport un peu moins direct vaut mieux qu'une URL fausse.
    expect(hoteDeStockage("https://api.exemple.fr")).toBe("https://api.exemple.fr");
  });
});

describe("SEUIL_REPRENABLE", () => {
  it("vaut exactement la tranche TUS imposée par Supabase", () => {
    // En dessous, TUS n'enverrait qu'une tranche : le protocole n'apporterait
    // rien qu'un `PUT` ne fasse déjà.
    expect(SEUIL_REPRENABLE).toBe(6 * 1024 * 1024);
  });
});

describe("messageDeRefus — le refus de taille", () => {
  it("nomme la limite du PROJET, et dit qu'elle n'est pas celle de POSTYNC", () => {
    // C'est le cas réel : bucket réglé à 300 Mo, projet plafonné à 50 Mo.
    // La plus basse gagne, et c'est ce que le message doit expliquer.
    const message = messageDeRefus(
      new ErreurTransport(
        "refusé",
        400,
        '{"statusCode":"413","error":"Payload too large","message":"The object exceeded the maximum allowed size of 52428800 bytes"}',
      ),
    );
    expect(message).toContain("50 Mo");
    expect(message).toContain("projet Supabase");
    expect(message).not.toContain("Réessayez");
  });

  it("reconnaît un 413 même sans corps exploitable", () => {
    const message = messageDeRefus(new ErreurTransport("refusé", 413, ""));
    expect(message).toContain("taille maximale autorisée par le projet");
  });

  it("n'invente pas de chiffre quand le corps n'en contient aucun", () => {
    const message = messageDeRefus(new ErreurTransport("refusé", 413, "Payload too large"));
    expect(message).not.toMatch(/\d+\s*(Mo|Ko)/);
  });
});

describe("messageDeRefus — les autres issues", () => {
  it("un 401 invite à se reconnecter, pas à réessayer en boucle", () => {
    expect(messageDeRefus(new ErreurTransport("x", 401, ""))).toContain("Reconnectez-vous");
  });

  it("un 403 ne dit PAS de se reconnecter : la session est valide", () => {
    // Ce cas est arrivé en production : RLS active sans aucune politique
    // d'insertion. Le message précédent envoyait l'utilisateur se reconnecter
    // en boucle alors que sa session n'avait jamais été en cause.
    const message = messageDeRefus(new ErreurTransport("x", 403, ""));
    expect(message).toContain("reconnu votre session");
    expect(message).toContain("règle d'accès");
    expect(message).not.toContain("Reconnectez-vous");
  });

  it("une coupure PROMET la reprise, parce que le transport la tient", () => {
    const message = messageDeRefus(new ErreurTransport("réseau", null, ""));
    expect(message).toContain("reprendra où il s'est arrêté");
  });

  it("un code inattendu est affiché tel quel, pour pouvoir être signalé", () => {
    expect(messageDeRefus(new ErreurTransport("x", 507, ""))).toContain("507");
  });

  it("une erreur d'un autre type reste compréhensible", () => {
    expect(messageDeRefus(new Error("boum"))).toContain("Vérifiez votre connexion");
  });
});
