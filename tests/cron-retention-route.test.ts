/**
 * `POST /api/cron/retention` — les branches d'AUTHENTIFICATION.
 *
 * Cette route supprime des comptes et efface des données de plateforme. Ses
 * refus valent donc autant que son travail, et ils n'étaient couverts par aucun
 * test : le dossier de validation les listait « à éprouver », et la seule
 * vérification réelle jamais faite est passée par le chemin autorisé.
 *
 * Tout est doublé — aucune base, aucun réseau, aucun secret. Ce qui est vérifié
 * ici est le comportement de la porte, pas ce qu'il y a derrière :
 *
 *   · en-tête absent            → 401, et la base n'est même pas ouverte ;
 *   · secret indisponible       → 503, JAMAIS 200 : une route qui purge ne
 *                                 s'ouvre pas « le temps de configurer » ;
 *   · secret d'une autre longueur → 401 (la comparaison à temps constant exige
 *                                 des longueurs égales, ce cas doit être traité
 *                                 avant elle, sans lever) ;
 *   · secret faux, même longueur → 401 ;
 *   · secret juste              → 200, et la passe est journalisée.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "0123456789abcdef0123456789abcdef";

const rpc = vi.fn();
const passe = vi.fn();
const consigner = vi.fn();

vi.mock("@/server/supabase/service-client", () => ({
  createServiceClient: () => ({ rpc }),
}));

vi.mock("@/server/social/retention", () => ({
  runYouTubeRetention: (...args: unknown[]) => passe(...args),
}));

vi.mock("@/server/social/retention-journal", () => ({
  consignerPasse: (...args: unknown[]) => consigner(...args),
  codeErreurControle: () => "unknown_error",
}));

vi.mock("@/server/social/providers", () => ({
  getProvider: () => null,
}));

const { POST } = await import("@/app/api/cron/retention/route");

function requete(entete?: string): Request {
  return new Request("https://exemple.invalid/api/cron/retention", {
    method: "POST",
    headers: entete === undefined ? {} : { "x-postync-cron": entete },
  });
}

const RAPPORT = {
  examines: 3,
  rafraichis: 1,
  purges: 1,
  reessais: 0,
  publicationsPurgees: 2,
  lots: 1,
  sature: false,
  resultats: [],
};

describe("POST /api/cron/retention — la porte", () => {
  beforeEach(() => {
    rpc.mockReset();
    passe.mockReset();
    consigner.mockReset();
    rpc.mockResolvedValue({ data: SECRET, error: null });
    passe.mockResolvedValue(RAPPORT);
    consigner.mockResolvedValue(undefined);
  });

  it("sans en-tête : 401, et la passe n'est jamais lancée", async () => {
    const reponse = await POST(requete());
    expect(reponse.status).toBe(401);
    expect(passe).not.toHaveBeenCalled();
    // La base n'est pas même interrogée : le refus est antérieur.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("secret indisponible en base : 503, jamais 200", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42883" } });
    const reponse = await POST(requete(SECRET));
    expect(reponse.status).toBe(503);
    expect(passe).not.toHaveBeenCalled();
  });

  it("secret configuré mais vide : 503 également", async () => {
    rpc.mockResolvedValue({ data: "", error: null });
    const reponse = await POST(requete(SECRET));
    expect(reponse.status).toBe(503);
    expect(passe).not.toHaveBeenCalled();
  });

  it("secret de longueur différente : 401 sans lever", async () => {
    // `timingSafeEqual` jette si les longueurs diffèrent : ce cas DOIT être
    // intercepté avant elle, sinon la route rendrait 500 au lieu de 401.
    const reponse = await POST(requete("trop-court"));
    expect(reponse.status).toBe(401);
    expect(passe).not.toHaveBeenCalled();
  });

  it("secret faux de même longueur : 401", async () => {
    const faux = `${"f".repeat(SECRET.length - 1)}0`;
    expect(faux.length).toBe(SECRET.length);
    const reponse = await POST(requete(faux));
    expect(reponse.status).toBe(401);
    expect(passe).not.toHaveBeenCalled();
  });

  it("secret juste : 200, rapport rendu et passe journalisée", async () => {
    const reponse = await POST(requete(SECRET));
    expect(reponse.status).toBe(200);
    expect(passe).toHaveBeenCalledTimes(1);
    await expect(reponse.json()).resolves.toEqual({
      examines: 3,
      rafraichis: 1,
      purges: 1,
      reessais: 0,
      publicationsPurgees: 2,
    });

    expect(consigner).toHaveBeenCalledTimes(1);
    const ligne = consigner.mock.calls[0][1] as Record<string, unknown>;
    expect(ligne.examined).toBe(3);
    expect(ligne.purged).toBe(1);
    expect(ligne.publications_purged).toBe(2);
    expect(ligne.saturated).toBe(false);
    expect(ligne.error_code).toBeNull();
    expect(typeof ligne.duration_ms).toBe("number");
  });

  it("passe en échec : 500, et le journal porte des compteurs NULS", async () => {
    passe.mockRejectedValue(new Error("boom"));
    const reponse = await POST(requete(SECRET));
    expect(reponse.status).toBe(500);

    const ligne = consigner.mock.calls[0][1] as Record<string, unknown>;
    // `null` veut dire INCONNU — des opérations partielles ont pu avoir lieu.
    // `0` dirait « mesuré : rien », ce qui serait faux.
    expect(ligne.examined).toBeNull();
    expect(ligne.purged).toBeNull();
    expect(ligne.saturated).toBeNull();
    expect(ligne.error_code).toBe("unknown_error");
  });
});
