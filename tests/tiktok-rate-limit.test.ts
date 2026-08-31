/**
 * Limiteur de débit TikTok — fenêtre glissante par jeton et par endpoint.
 *
 * Le plafond qui compte est celui de `video/init/` : 6 requêtes par minute et
 * par jeton utilisateur. Un lot programmé sur un même compte l'atteint en six
 * publications, et un HTTP 429 en plein `video/init/` est particulièrement
 * coûteux — on ne sait pas si TikTok a déjà accepté la tâche, donc on ne peut
 * pas réessayer sans risquer un doublon.
 *
 * L'horloge est injectée : aucun test n'attend réellement une minute.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  acquireTikTokSlot,
  resetTikTokRateLimits,
  TikTokRateLimitError,
  TIKTOK_RATE_LIMITS,
} from "@/server/social/providers/tiktok-rate-limit";

/** Horloge virtuelle : `sleep` fait avancer le temps, il ne le subit pas. */
function horlogeVirtuelle(depart = 1_000_000) {
  let instant = depart;
  return {
    now: () => instant,
    sleep: async (ms: number) => {
      instant += ms;
    },
    avancer: (ms: number) => {
      instant += ms;
    },
    lire: () => instant,
  };
}

beforeEach(() => {
  resetTikTokRateLimits();
});

describe("plafonds officiels", () => {
  it("reproduit exactement ceux publiés par TikTok", () => {
    // Documentation vérifiée le 2026-08-31. Ces trois valeurs sont
    // DIFFÉRENTES : les uniformiser reviendrait soit à s'auto-brider sur
    // creator_info, soit à dépasser sur video/init.
    expect(TIKTOK_RATE_LIMITS).toEqual({ creatorInfo: 20, videoInit: 6, statusFetch: 30 });
  });
});

describe("fenêtre glissante", () => {
  it("laisse passer le plafond sans attendre", async () => {
    const h = horlogeVirtuelle();
    const debut = h.lire();
    for (let i = 0; i < 6; i += 1) {
      await acquireTikTokSlot("videoInit", "token-a", h);
    }
    expect(h.lire()).toBe(debut);
  });

  it("l'attente est ancrée sur l'appel le PLUS ANCIEN, pas sur le dernier", async () => {
    const h = horlogeVirtuelle();
    const debut = h.lire();

    // Un premier appel, puis les cinq autres 45 secondes plus tard.
    await acquireTikTokSlot("videoInit", "token-a", h);
    h.avancer(45_000);
    for (let i = 0; i < 5; i += 1) {
      await acquireTikTokSlot("videoInit", "token-a", h);
    }

    // Le septième doit attendre l'expiration du PREMIER : environ 15 s, ce
    // qui tient dans le budget. Un ancrage sur le dernier appel demanderait
    // 60 s, dépasserait le budget, et cette ligne échouerait — c'est
    // exactement ce que le test distingue.
    await acquireTikTokSlot("videoInit", "token-a", h);

    const ecoule = h.lire() - debut;
    expect(ecoule).toBeGreaterThanOrEqual(60_000);
    expect(ecoule).toBeLessThan(61_000);
  });

  it("une fenêtre écoulée n'impose plus rien", async () => {
    const h = horlogeVirtuelle();
    for (let i = 0; i < 6; i += 1) {
      await acquireTikTokSlot("videoInit", "token-a", h);
    }
    h.avancer(60_001);

    const avant = h.lire();
    for (let i = 0; i < 6; i += 1) {
      await acquireTikTokSlot("videoInit", "token-a", h);
    }
    expect(h.lire()).toBe(avant);
  });
});

describe("cloisonnement", () => {
  it("deux jetons ne se limitent pas l'un l'autre", async () => {
    // Le plafond TikTok est PAR jeton utilisateur : mutualiser le compteur
    // ferait attendre un client pour les publications d'un autre.
    const h = horlogeVirtuelle();
    for (let i = 0; i < 6; i += 1) {
      await acquireTikTokSlot("videoInit", "token-a", h);
    }
    const avant = h.lire();
    for (let i = 0; i < 6; i += 1) {
      await acquireTikTokSlot("videoInit", "token-b", h);
    }
    expect(h.lire()).toBe(avant);
  });

  it("deux jetons au préfixe commun restent distincts", async () => {
    // La clé est un haché : un préfixe partagé ne doit pas les confondre.
    const h = horlogeVirtuelle();
    for (let i = 0; i < 6; i += 1) {
      await acquireTikTokSlot("videoInit", "act.commun-AAAA", h);
    }
    const avant = h.lire();
    await acquireTikTokSlot("videoInit", "act.commun-BBBB", h);
    expect(h.lire()).toBe(avant);
  });

  it("chaque endpoint a son propre compteur", async () => {
    const h = horlogeVirtuelle();
    for (let i = 0; i < 6; i += 1) {
      await acquireTikTokSlot("videoInit", "token-a", h);
    }
    const avant = h.lire();
    // 20 créneaux restent ouverts sur creator_info malgré video/init saturé.
    for (let i = 0; i < 20; i += 1) {
      await acquireTikTokSlot("creatorInfo", "token-a", h);
    }
    expect(h.lire()).toBe(avant);
  });
});

describe("budget d'attente", () => {
  it("renonce plutôt que de bloquer la requête une minute entière", async () => {
    // Une fonction serverless qui patiente 60 s est déjà perdue : mieux vaut
    // un échec net, repris au réveil suivant du planificateur.
    const h = horlogeVirtuelle();
    for (let i = 0; i < 6; i += 1) {
      await acquireTikTokSlot("videoInit", "token-a", h);
    }
    await expect(acquireTikTokSlot("videoInit", "token-a", h)).rejects.toBeInstanceOf(
      TikTokRateLimitError,
    );
  });

  it("le refus n'a PAS consommé de créneau", async () => {
    // Sinon un appelant qui insiste repousserait indéfiniment sa propre
    // fenêtre, et le plafond ne se libérerait jamais.
    const h = horlogeVirtuelle();
    for (let i = 0; i < 6; i += 1) {
      await acquireTikTokSlot("videoInit", "token-a", h);
    }
    await acquireTikTokSlot("videoInit", "token-a", h).catch(() => null);

    h.avancer(60_001);
    const avant = h.lire();
    for (let i = 0; i < 6; i += 1) {
      await acquireTikTokSlot("videoInit", "token-a", h);
    }
    expect(h.lire()).toBe(avant);
  });

  it("attend quand l'attente reste dans le budget", async () => {
    const h = horlogeVirtuelle();
    for (let i = 0; i < 6; i += 1) {
      await acquireTikTokSlot("videoInit", "token-a", h);
    }
    // 45 s se sont écoulées : il reste 15 s à patienter, sous le budget.
    h.avancer(45_000);
    await expect(acquireTikTokSlot("videoInit", "token-a", h)).resolves.toBeUndefined();
    expect(h.lire()).toBeGreaterThanOrEqual(1_060_000);
  });
});
