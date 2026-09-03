/**
 * Rétention YouTube — le TRAITEMENT COMPLET, dépendances simulées.
 *
 * AUCUN APPEL GOOGLE, AUCUNE BASE. Le client Supabase est une doublure en
 * mémoire qui enregistre ce qu'on lui demande ; le provider est une doublure
 * dont on choisit le comportement par test. Rien ici ne sort du processus.
 *
 * Le fichier voisin `youtube-retention.test.ts` couvre la POLITIQUE — deux
 * fonctions pures. Celui-ci couvre le CÂBLAGE : que la bonne décision
 * déclenche bien la bonne écriture, et surtout qu'une mauvaise ne déclenche
 * rien.
 *
 * Cinq scénarios : succès, panne passagère, révocation, données périmées,
 * échec de la purge elle-même.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { IDENTITY_MAX_AGE_MS, TERMINAUX, runYouTubeRetention } from "@/server/social/retention";
import { SocialIdentityUnavailableError, type SocialProvider } from "@/server/social/providers/types";

const MAINTENANT = Date.parse("2026-09-03T12:00:00.000Z");
const JOUR = 24 * 60 * 60 * 1000;
const ilYA = (j: number) => new Date(MAINTENANT - j * JOUR).toISOString();

/** Ce que la doublure a subi : c'est là-dessus que portent les assertions. */
type Journal = {
  updates: { table: string; valeurs: Record<string, unknown>; id?: string }[];
  rpc: { nom: string; args: Record<string, unknown> }[];
};

function compteYouTube(p: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    workspace_id: "ws-1",
    platform: "youtube",
    status: "active",
    connected_at: ilYA(40),
    identity_refreshed_at: ilYA(10),
    identity_attempted_at: ilYA(10),
    identity_refresh_failures: 0,
    provider_account_id: "UC-chaine",
    access_token_id: "vault-access",
    refresh_token_id: "vault-refresh",
    token_expires_at: new Date(MAINTENANT + 3600_000).toISOString(),
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    ...p,
  };
}

/**
 * Doublure Supabase minimale. Elle n'imite pas PostgREST : elle rend ce que
 * le test lui donne et note ce qu'on lui demande d'écrire.
 */
function fauxClient(comptes: Record<string, unknown>[], journal: Journal, options: {
  rpcErreur?: boolean;
  publicationsPurgees?: number;
  /** Statut relu APRÈS un échec, comme l'écrirait `markNeedsReconnect`. */
  statutApresEchec?: { status: string; status_detail: string | null };
} = {}) {
  const chaine = (table: string) => {
    const etat: { valeurs?: Record<string, unknown>; id?: string } = {};
    const self: Record<string, unknown> = {};
    const rendre = () => self;
    Object.assign(self, {
      select: rendre,
      eq: (colonne: string, valeur: unknown) => {
        if (colonne === "id") etat.id = String(valeur);
        return self;
      },
      in: rendre,
      is: rendre,
      lt: rendre,
      order: rendre,
      update: (valeurs: Record<string, unknown>) => {
        etat.valeurs = valeurs;
        return self;
      },
      limit: async () => ({ data: comptes, error: null }),
      maybeSingle: async () => {
        // La relecture de statut ne demande que deux colonnes : on la
        // reconnaît à cela, et on rend l'état d'après-échec s'il est fourni.
        if (options.statutApresEchec && journal.updates.length > 0) {
          return { data: options.statutApresEchec, error: null };
        }
        return { data: comptes[0] ?? null, error: null };
      },
      then: undefined,
    });
    // `update(...).eq(...)` est attendu (thenable) ; `update(...).select()`
    // rend une liste. On enregistre au moment où la chaîne est consommée.
    (self as { then: unknown }).then = (resoudre: (v: unknown) => void) => {
      if (etat.valeurs) journal.updates.push({ table, valeurs: etat.valeurs, id: etat.id });
      const data =
        table === "social_publications"
          ? Array.from({ length: options.publicationsPurgees ?? 0 }, (_, i) => ({ id: `pub-${i}` }))
          : [];
      return Promise.resolve({ data, error: null }).then(resoudre);
    };
    return self;
  };

  return {
    from: (table: string) => chaine(table),
    rpc: async (nom: string, args: Record<string, unknown>) => {
      journal.rpc.push({ nom, args });
      return options.rpcErreur
        ? { data: null, error: { code: "P0001", message: "echec" } }
        : { data: [{ cancelled: 0, purged: 0 }], error: null };
    },
  } as never;
}

function fauxProvider(comportement: {
  refresh?: () => Promise<unknown>;
  fetchIdentity?: () => Promise<unknown>;
}): SocialProvider {
  return {
    platform: "youtube",
    usesPkce: false,
    buildAuthUrl: () => "https://example.invalid",
    exchangeCode: async () => {
      throw new Error("non utilisé");
    },
    refresh: comportement.refresh ?? (async () => ({
      accessToken: "at-neuf",
      refreshToken: null,
      expiresAt: new Date(MAINTENANT + 3600_000).toISOString(),
      refreshExpiresAt: null,
      scopes: [],
    })),
    fetchIdentity: comportement.fetchIdentity ?? (async () => ({
      providerAccountId: "UC-chaine",
      displayName: "Chaîne relue",
      avatarUrl: "https://yt.example/a.jpg",
    })),
    publisher: { requiredScopes: [], supportedMediaKinds: ["reel"] as const },
  } as unknown as SocialProvider;
}

let journal: Journal;

beforeEach(() => {
  journal = { updates: [], rpc: [] };
  // Le coffre n'est PAS simulé par un mock de module : `vaultRead` passe par
  // `db.rpc`, donc par la doublure ci-dessus. Rien ne sort du processus, et le
  // chemin réel de `getUsableAccessToken` est exercé pour de bon.
});

const deps = (client: unknown, provider: SocialProvider) => ({
  db: client as never,
  getProvider: (p: string) => (p === "youtube" ? provider : null),
  now: () => MAINTENANT,
});

describe("succès : l'identité est relue et l'horloge repart", () => {
  it("écrit le nom relu, horodate la RÉUSSITE et remet le compteur à zéro", async () => {
    const client = fauxClient([compteYouTube()], journal);
    const rapport = await runYouTubeRetention(deps(client, fauxProvider({})));

    expect(rapport.rafraichis).toBe(1);
    expect(rapport.purges).toBe(0);
    // On vise `disconnect_social_account` NOMMÉMENT : le coffre passe lui
    // aussi par `rpc`, et compter le total masquerait ce qui compte.
    expect(journal.rpc.filter((r) => r.nom === "disconnect_social_account")).toHaveLength(0);

    const reussite = journal.updates.find((u) => "identity_refreshed_at" in u.valeurs);
    expect(reussite?.valeurs).toMatchObject({
      display_name: "Chaîne relue",
      identity_refreshed_at: new Date(MAINTENANT).toISOString(),
      identity_refresh_failures: 0,
    });
  });

  it("horodate la TENTATIVE avant l'appel distant, séparément de la réussite", async () => {
    // Sans cela, un compte qui échoue reviendrait en tête à chaque passe.
    const client = fauxClient([compteYouTube()], journal);
    await runYouTubeRetention(deps(client, fauxProvider({})));
    const tentative = journal.updates.find(
      (u) => "identity_attempted_at" in u.valeurs && !("identity_refreshed_at" in u.valeurs),
    );
    expect(tentative).toBeDefined();
  });
});

describe("panne passagère : rien n'est détruit", () => {
  it("compte l'échec, ne purge pas, n'avance pas l'horloge de rétention", async () => {
    const client = fauxClient([compteYouTube()], journal);
    const provider = fauxProvider({
      fetchIdentity: async () => {
        throw new Error("youtube channels: HTTP 503 backendError");
      },
    });

    const rapport = await runYouTubeRetention(deps(client, provider));

    expect(rapport.purges).toBe(0);
    expect(rapport.reessais).toBe(1);
    // AUCUN appel à la purge : c'est l'assertion qui compte.
    expect(journal.rpc.filter((r) => r.nom === "disconnect_social_account")).toHaveLength(0);
    // Et l'horloge de rétention n'a pas bougé : une donnée ancienne ne doit
    // pas ressortir « fraîche » d'un échec.
    expect(journal.updates.some((u) => "identity_refreshed_at" in u.valeurs)).toBe(false);
    expect(journal.updates.some((u) => u.valeurs.identity_refresh_failures === 1)).toBe(true);
  });

  it("un compte Google sans chaîne est passager, pas révoqué", async () => {
    const client = fauxClient([compteYouTube()], journal);
    const provider = fauxProvider({
      fetchIdentity: async () => {
        throw new SocialIdentityUnavailableError("youtubeSignupRequired");
      },
    });
    const rapport = await runYouTubeRetention(deps(client, provider));
    expect(rapport.purges).toBe(0);
    expect(rapport.reessais).toBe(1);
  });
});

describe("révocation : purge immédiate", () => {
  it("un invalid_grant au renouvellement déclenche la purge", async () => {
    const client = fauxClient([compteYouTube()], journal, {
      // `getUsableAccessToken` classe l'échec et pose ce statut lui-même.
      statutApresEchec: { status: "revoked", status_detail: "refresh_revoked" },
    });
    const provider = fauxProvider({
      refresh: async () => {
        throw new Error("google refresh: HTTP 400 invalid_grant");
      },
    });

    const rapport = await runYouTubeRetention(deps(client, provider));

    expect(rapport.purges).toBe(1);
    const appel = journal.rpc.find((r) => r.nom === "disconnect_social_account");
    expect(appel?.args).toEqual({ p_account_id: "acc-1", p_workspace_id: "ws-1" });
  });

  it("un compte DÉJÀ marqué révoqué est purgé sans rien redemander à Google", async () => {
    const client = fauxClient([compteYouTube({ status: "revoked" })], journal);
    const provider = fauxProvider({
      refresh: async () => {
        throw new Error("le renouvellement ne doit PAS être tenté");
      },
      fetchIdentity: async () => {
        throw new Error("la lecture ne doit PAS être tentée");
      },
    });

    const rapport = await runYouTubeRetention(deps(client, provider));
    expect(rapport.purges).toBe(1);
    expect(journal.rpc).toHaveLength(1);
  });
});

describe("données périmées : relire d'abord, purger seulement si ça échoue", () => {
  const perime = () =>
    compteYouTube({
      identity_refreshed_at: new Date(MAINTENANT - IDENTITY_MAX_AGE_MS - JOUR).toISOString(),
      identity_attempted_at: ilYA(2),
    });

  it("une identité de 31 jours qui se relit est SAUVÉE, pas détruite", async () => {
    // « Delete OR refresh » : le refresh satisfait l'obligation. Purger une
    // identité qu'on sait relire transformerait un retard de notre passe en
    // perte de données.
    const client = fauxClient([perime()], journal);
    const rapport = await runYouTubeRetention(deps(client, fauxProvider({})));
    expect(rapport.rafraichis).toBe(1);
    expect(rapport.purges).toBe(0);
    expect(journal.rpc.filter((r) => r.nom === "disconnect_social_account")).toHaveLength(0);
  });

  it("purge si la relecture échoue au-delà du plafond", async () => {
    const client = fauxClient([perime()], journal);
    const provider = fauxProvider({
      fetchIdentity: async () => {
        throw new Error("youtube channels: HTTP 503 backendError");
      },
    });
    const rapport = await runYouTubeRetention(deps(client, provider));
    expect(rapport.purges).toBe(1);
    expect(rapport.resultats).toContainEqual({
      accountId: "acc-1", action: "purged", reason: "stale",
    });
  });
});

describe("capacité : plusieurs lots par invocation", () => {
  it("enchaîne les lots tant qu'il reste du travail", async () => {
    // Un seul lot par jour plafonnait le service à 25 comptes traités
    // quotidiennement, donc ~175 comptes au rythme hebdomadaire. Au-delà, la
    // file s'allongeait en silence.
    let restants = 7;
    const client = {
      from: () => {
        const self: Record<string, unknown> = {};
        const rendre = () => self;
        Object.assign(self, {
          select: rendre, eq: rendre, in: rendre, is: rendre, lt: rendre,
          order: rendre, update: rendre,
          limit: async () => {
            const n = Math.min(3, restants);
            restants -= n;
            return {
              data: Array.from({ length: n }, (_, i) => ({
                ...compteYouTube({ id: `acc-${restants}-${i}`, status: "revoked" }),
              })),
              error: null,
            };
          },
          maybeSingle: async () => ({ data: null, error: null }),
          then: (r: (v: unknown) => void) => Promise.resolve({ data: [], error: null }).then(r),
        });
        return self;
      },
      rpc: async (nom: string, args: Record<string, unknown>) => {
        journal.rpc.push({ nom, args });
        return { data: [{ cancelled: 0, purged: 0 }], error: null };
      },
    } as never;

    const rapport = await runYouTubeRetention({
      ...deps(client, fauxProvider({})),
      batchSize: 3,
    });

    // 3 + 3 + 1 : le lot incomplet arrête la boucle.
    expect(rapport.lots).toBe(3);
    expect(rapport.examines).toBe(7);
    expect(rapport.sature).toBe(false);
  });

  it("signale la saturation plutôt que de laisser la file grossir en silence", async () => {
    // Budget épuisé alors qu'il reste du travail : le rapport doit le DIRE.
    const client = fauxClient([compteYouTube({ status: "revoked" })], journal);
    let t = 0;
    const rapport = await runYouTubeRetention({
      ...deps(client, fauxProvider({})),
      batchSize: 1,
      budgetMs: 10,
      monotonic: () => (t += 100),
    });
    expect(rapport.sature).toBe(true);
  });
});

describe("échec de la purge : signalé, jamais silencieux", () => {
  it("n'incrémente pas le compteur de purges et laisse une trace de reprise", async () => {
    // Une purge qui échoue ne doit pas être comptée comme faite : le délai
    // réglementaire court toujours, et la passe suivante doit réessayer.
    const client = fauxClient([compteYouTube({ status: "revoked" })], journal, { rpcErreur: true });
    const rapport = await runYouTubeRetention(deps(client, fauxProvider({})));

    expect(rapport.purges).toBe(0);
    expect(rapport.resultats).toContainEqual({
      accountId: "acc-1",
      action: "retry",
      detail: "purge_failed",
    });
  });
});

describe("publications : rien de ce qui est EN VOL n'est touché", () => {
  /**
   * LE RISQUE. `container_id` porte l'URI de la session d'envoi résumable.
   * L'effacer sur une publication `pending` ferait rouvrir une session au
   * prochain réveil du planificateur — donc CRÉER UNE SECONDE VIDÉO sur la
   * chaîne de l'utilisateur. Et `scheduled` peut viser une échéance à 364
   * jours : compter depuis la création purgerait une publication à venir.
   *
   * On lit le filtre dans la source. Une doublure rendrait ce qu'on lui
   * souffle ; ici c'est la REQUÊTE qu'il faut prouver.
   */
  const source = () => {
    const brut = readFileSync(resolve(process.cwd(), "src/server/social/retention.ts"), "utf8");
    const debut = brut.indexOf("export async function purgeStalePublications");
    return brut.slice(debut, brut.indexOf(String.fromCharCode(10) + "}", debut));
  };

  it("restreint aux statuts terminaux : ni scheduled, ni pending", () => {
    const bloc = source();
    expect(bloc).toMatch(/\.in\("status",\s*TERMINAUX\)/);
    expect(TERMINAUX).toEqual(["published", "failed", "canceled"]);
    // Les deux états en vol sont ABSENTS de la liste. Le schéma ne comporte
    // pas de `processing` : c'est `pending` qui joue ce rôle.
    expect(TERMINAUX as readonly string[]).not.toContain("pending");
    expect(TERMINAUX as readonly string[]).not.toContain("scheduled");
  });

  it("mesure l'âge sur updated_at, JAMAIS sur created_at", () => {
    // Une publication créée aujourd'hui pour un envoi dans 60 jours serait
    // purgée au 30e jour si l'on comptait depuis la création — alors qu'elle
    // n'est même pas partie.
    const bloc = source();
    expect(bloc).toMatch(/\.lt\("updated_at",\s*limite\)/);
    expect(bloc).not.toMatch(/\.lt\("created_at"/);
  });

  it("n'efface jamais container_id d'une ligne encore réclamable", () => {
    // Formulation complémentaire du même invariant, côté effets : les quatre
    // champs effacés le sont, mais uniquement sous le filtre ci-dessus.
    const bloc = source();
    expect(bloc).toMatch(/container_id: null/);
    expect(bloc).toMatch(/\.is\("purged_at",\s*null\)/);
  });
});

describe("publications : les identifiants de plateforme vieillissent aussi", () => {
  it("efface les quatre champs sans toucher au contenu de l'utilisateur", async () => {
    const client = fauxClient([], journal, { publicationsPurgees: 2 });
    const rapport = await runYouTubeRetention(deps(client, fauxProvider({})));

    expect(rapport.publicationsPurgees).toBe(2);
    const purge = journal.updates.find((u) => u.table === "social_publications");
    expect(purge?.valeurs).toMatchObject({
      provider_account_id: null,
      provider_media_id: null,
      permalink: null,
      container_id: null,
    });
    // Ce qui vient de l'utilisateur n'est même pas mentionné dans l'écriture.
    for (const champ of ["caption", "media_url", "media_asset_id", "status", "published_at"]) {
      expect(purge?.valeurs).not.toHaveProperty(champ);
    }
  });
});
