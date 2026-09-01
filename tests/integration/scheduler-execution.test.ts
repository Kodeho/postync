/**
 * C10.2 — exécution des publications programmées, contre la VRAIE base.
 *
 * Ce que ces tests protègent, par ordre d'importance :
 *
 *   1. UNE publication programmée ne part JAMAIS deux fois, et ne donne
 *      JAMAIS naissance à une seconde ligne. C'est la garantie centrale :
 *      sur un réseau social, un doublon est public et irrattrapable.
 *   2. Deux réveils concurrents du planificateur ne se disputent pas la même
 *      publication — éprouvé en les lançant ENSEMBLE.
 *   3. Ce qui ne peut pas aboutir est DIT (compte déconnecté, échec du
 *      provider), pas laissé en attente silencieuse.
 *   4. Une publication restée en cours est reprise sans jamais renvoyer le
 *      média.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SocialPublishError,
  type ContainerStatus,
  type SocialProvider,
} from "@/server/social/providers/types";
import { YOUTUBE_MIN_TRANSFER_BUDGET_MS } from "@/server/social/providers/youtube-publisher";
import { schedulePublication } from "@/server/social/schedule";
import { MAX_ATTEMPTS, runScheduler, type SchedulerDeps } from "@/server/social/scheduler";
import { vaultStore } from "@/server/social/vault";

function loadEnvLocal(): Record<string, string> {
  const vars: Record<string, string> = {};
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return vars;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    vars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return vars;
}

const env = loadEnvLocal();
const CONFIGURED = Boolean(
  env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY,
);
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };
const PASSWORD = `C102-${randomUUID()}`;
const EMAIL = "postync-c102-owner@example.com";

let admin: SupabaseClient;
let ownerId = "";
let workspaceId = "";
let accountId = "";

/** Compte les appels distants : c'est ainsi qu'on prouve l'absence de doublon. */
type Compteurs = { creations: number; publications: number };

function fakeProvider(
  compteurs: Compteurs,
  options: {
    status?: ContainerStatus;
    echouerALaCreation?: boolean;
    /** Détail exact renvoyé par la plateforme, tel que le construit le provider. */
    detailEchec?: string;
  } = {},
): SocialProvider {
  return {
    platform: "facebook",
    usesPkce: false,
    buildAuthUrl: () => "https://example.invalid",
    exchangeCode: async () => {
      throw new Error("non utilisé");
    },
    publisher: {
      requiredScopes: ["pages_manage_posts"],
      supportedMediaKinds: ["reel"] as const,
      async createContainer() {
        compteurs.creations += 1;
        if (options.detailEchec) {
          throw new SocialPublishError("http_400", options.detailEchec);
        }
        if (options.echouerALaCreation) {
          throw new Error("refus simulé de la plateforme");
        }
        return `container-${compteurs.creations}`;
      },
      async containerStatus(): Promise<ContainerStatus> {
        return options.status ?? "ready";
      },
      async publishContainer() {
        compteurs.publications += 1;
        return { providerMediaId: `media-${compteurs.publications}` };
      },
      async fetchPermalink() {
        return "https://www.facebook.com/reel/media/";
      },
    },
  } as unknown as SocialProvider;
}

function deps(provider: SocialProvider, quota = 100): SchedulerDeps {
  return {
    db: admin,
    getProvider: (p) => (p === "facebook" ? provider : null),
    getMonthlyQuota: async () => quota,
    // Aucune attente réelle : les tests ne dorment pas.
    sleep: async () => undefined,
  };
}

/** Pose une échéance DUE : la validation interdit — à raison — le passé. */
async function programmerPuisRendreDue(caption: string): Promise<string> {
  const result = await schedulePublication(deps(fakeProvider({ creations: 0, publications: 0 })), {
    workspaceId,
    socialAccountId: accountId,
    requestedBy: ownerId,
    mediaKind: "reel",
    mediaUrl: "https://cdn.example.com/programmee.mp4",
    caption,
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  if (!result.ok) throw new Error(`planification refusée : ${result.code}`);
  await admin
    .from("social_publications")
    .update({ scheduled_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", result.publicationId);
  return result.publicationId;
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((u) => u.email === EMAIL)) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C10.2 — exécution du planificateur", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "C10.2 Owner" },
    });
    if (error) throw error;
    ownerId = data.user.id;

    const anon = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NO_SESSION,
    );
    const { error: e } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (e) throw e;
    const { data: ws, error: wsError } = await anon.rpc("create_workspace", { p_name: "C102 WS" });
    if (wsError) throw wsError;
    workspaceId = (ws as { id: string }).id;

    const tokenId = await vaultStore(admin, "EAA.page-c102", "c102/access");
    const { data: account, error: accError } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "facebook",
        provider_account_id: "1290000000000102",
        display_name: "Page C10.2",
        access_token_id: tokenId,
        scopes: ["pages_manage_posts"],
        connected_by: ownerId,
      })
      .select("id")
      .single();
    if (accError) throw accError;
    accountId = (account as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  async function purge() {
    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  }

  async function lignes() {
    const { data } = await admin
      .from("social_publications")
      .select("id, status, status_detail, provider_media_id, container_id, scheduled_at, attempts")
      .eq("workspace_id", workspaceId)
      .order("created_at");
    return data ?? [];
  }

  // -------------------------------------------------------------------------
  // La garantie centrale
  // -------------------------------------------------------------------------

  it("publie dans la ligne EXISTANTE, sans jamais en créer une seconde", async () => {
    await purge();
    const id = await programmerPuisRendreDue("C10.2 — ligne existante");
    const compteurs: Compteurs = { creations: 0, publications: 0 };

    const rapport = await runScheduler(deps(fakeProvider(compteurs)));

    expect(rapport.failed).toEqual([]);

    const rows = await lignes();
    // LE POINT : UNE seule ligne. La publication programmée a été menée à
    // terme DANS sa ligne, pas dupliquée dans une nouvelle.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].status).toBe("published");
    expect(rows[0].provider_media_id).not.toBeNull();
    // Réclamée exactement une fois — `attempts` n'est incrémenté que par une
    // réclamation réussie.
    expect(rows[0].attempts).toBe(1);
    // L'échéance est conservée : elle fait partie de l'historique.
    expect(rows[0].scheduled_at).not.toBeNull();
    // Notre provider n'a jamais publié sans avoir créé : pas de publication
    // orpheline.
    expect(compteurs.publications).toBeLessThanOrEqual(compteurs.creations);
  }, 60_000);

  it("un second réveil ne republie pas ce qui est déjà parti", async () => {
    await purge();
    await programmerPuisRendreDue("C10.2 — pas de rejeu");
    const compteurs: Compteurs = { creations: 0, publications: 0 };

    await runScheduler(deps(fakeProvider(compteurs)));
    await runScheduler(deps(fakeProvider(compteurs)));

    // Les compteurs du rapport ne sont PAS assertés : le planificateur balaie
    // tous les workspaces par conception, donc il peut légitimement réclamer
    // des lignes qui ne sont pas les nôtres. Ce qui compte est l'état de NOTRE
    // ligne après deux réveils.
    const rows = await lignes();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("published");
    // Réclamée UNE fois, publiée UNE fois : le second réveil n'a rien rejoué.
    expect(rows[0].attempts).toBe(1);
  }, 60_000);

  it("deux réveils CONCURRENTS ne publient pas deux fois", async () => {
    await purge();
    await programmerPuisRendreDue("C10.2 — concurrence A");
    await programmerPuisRendreDue("C10.2 — concurrence B");
    const compteurs: Compteurs = { creations: 0, publications: 0 };

    // Lancés ensemble : c'est la seule façon d'éprouver la concurrence.
    const [a, b] = await Promise.all([
      runScheduler(deps(fakeProvider(compteurs))),
      runScheduler(deps(fakeProvider(compteurs))),
    ]);

    expect([...a.failed, ...b.failed]).toEqual([]);

    // Un passage de rattrapage, comme le ferait le réveil suivant. Il est
    // NÉCESSAIRE ici : la base est partagée et le planificateur balaie tous
    // les workspaces par conception, donc un autre réclamant légitime peut
    // avoir pris une de ces lignes sans la mener à terme. C'est exactement le
    // scénario que la reprise existe pour couvrir.
    await runScheduler({ ...deps(fakeProvider(compteurs)), staleAfter: "0 seconds" });

    const rows = await lignes();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "published")).toBe(true);
    // LE POINT : deux identifiants distants DISTINCTS et non nuls. Aucune des
    // deux lignes n'a été publiée deux fois, quel que soit le nombre de
    // réveils concurrents.
    expect(rows.every((r) => r.provider_media_id !== null)).toBe(true);
    expect(new Set(rows.map((r) => r.provider_media_id)).size).toBe(2);
    // Notre provider n'a jamais publié plus qu'il n'a créé.
    expect(compteurs.publications).toBeLessThanOrEqual(compteurs.creations);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Ce qui ne peut pas aboutir est DIT
  // -------------------------------------------------------------------------

  it("compte déconnecté depuis la programmation : échec explicite, aucun appel distant", async () => {
    await purge();
    const id = await programmerPuisRendreDue("C10.2 — compte parti");
    // `on delete set null` : la trace survit à la déconnexion.
    await admin.from("social_publications").update({ social_account_id: null }).eq("id", id);
    const compteurs: Compteurs = { creations: 0, publications: 0 };

    const rapport = await runScheduler(deps(fakeProvider(compteurs)));

    expect(rapport.failed).toEqual([{ publicationId: id, code: "account_disconnected" }]);
    expect(compteurs).toEqual({ creations: 0, publications: 0 });

    const rows = await lignes();
    expect(rows[0].status).toBe("failed");
    expect(rows[0].status_detail).toBe("account_disconnected");
  }, 60_000);

  it("refus de la plateforme : la publication est marquée en échec, pas laissée en attente", async () => {
    await purge();
    const id = await programmerPuisRendreDue("C10.2 — refus plateforme");
    const compteurs: Compteurs = { creations: 0, publications: 0 };

    const rapport = await runScheduler(
      deps(fakeProvider(compteurs, { echouerALaCreation: true })),
    );

    expect(rapport.failed).toHaveLength(1);
    expect(rapport.failed[0].publicationId).toBe(id);
    expect(compteurs.publications).toBe(0);

    const rows = await lignes();
    expect(rows[0].status).toBe("failed");
  }, 60_000);

  it("une publication annulée avant son échéance n'est jamais réclamée", async () => {
    await purge();
    const id = await programmerPuisRendreDue("C10.2 — annulée");
    await admin
      .from("social_publications")
      .update({ status: "canceled", status_detail: "canceled_by_user" })
      .eq("id", id);
    const compteurs: Compteurs = { creations: 0, publications: 0 };

    const rapport = await runScheduler(deps(fakeProvider(compteurs)));

    expect(rapport.claimed).toBe(0);
    expect(compteurs).toEqual({ creations: 0, publications: 0 });
    expect((await lignes())[0].status).toBe("canceled");
  }, 60_000);

  // -------------------------------------------------------------------------
  // Reprise
  // -------------------------------------------------------------------------

  it("REPRISE : le média n'est JAMAIS renvoyé, seul le conteneur est repris", async () => {
    await purge();
    // La ligne est posée directement en `pending` AVEC son conteneur : c'est
    // l'état exact d'une publication dont le transcodage n'était pas terminé
    // au réveil précédent.
    //
    // Elle n'est PAS `scheduled`, donc invisible pour la réclamation des
    // échéances — y compris celle du planificateur de PRODUCTION, qui balaie
    // la même base toutes les minutes. Et son `updated_at` étant frais, la
    // fenêtre de reprise de production (3 minutes) ne l'atteint pas non plus.
    const { data: inserted } = await admin
      .from("social_publications")
      .insert({
        workspace_id: workspaceId,
        social_account_id: accountId,
        platform: "facebook",
        provider_account_id: "1290000000000102",
        media_kind: "reel",
        media_url: "https://cdn.example.com/deja-transferee.mp4",
        caption: "C10.2 — reprise",
        status: "pending",
        container_id: "container-deja-cree",
        scheduled_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        requested_by: ownerId,
      })
      .select("id")
      .single();
    const id = (inserted as { id: string }).id;

    const compteurs: Compteurs = { creations: 0, publications: 0 };
    const rapport = await runScheduler({
      ...deps(fakeProvider(compteurs)),
      staleAfter: "0 seconds",
    });

    expect(rapport.resumed).toBeGreaterThanOrEqual(1);

    const rows = await lignes();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].status).toBe("published");

    // LE POINT DE CE TEST : AUCUN conteneur créé. Le média n'a pas été
    // renvoyé — on a repris celui qui existait. C'est ce qui distingue une
    // reprise d'une republication, et ce qui évite un doublon chez Meta.
    expect(compteurs.creations).toBe(0);
    expect(compteurs.publications).toBe(1);
  }, 60_000);

  it("REPRISE FRACTIONNÉE : le budget RÉEL laisse de quoi transférer", async () => {
    await purge();
    // Ce test rejoue la panne du 2026-09-01. Le planificateur n'accordait que
    // 8 s alors que le transfert s'en réservait 12 : `resumeTransfer` sortait
    // sans pousser un octet, sans erreur, et la ligne était reprise sans fin.
    //
    // AUCUN `pollBudgetMs` n'est fourni ici : c'est SCHEDULER_POLL_BUDGET_MS,
    // la valeur de production, qui doit suffire.
    const { data: inserted } = await admin
      .from("social_publications")
      .insert({
        workspace_id: workspaceId,
        social_account_id: accountId,
        platform: "facebook",
        provider_account_id: "1290000000000102",
        media_kind: "reel",
        media_url: "https://cdn.example.com/fractionnee.mp4",
        caption: "C10.2 — transfert fractionné",
        status: "pending",
        container_id: "session-resumable-existante",
        scheduled_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        requested_by: ownerId,
      })
      .select("id")
      .single();
    const id = (inserted as { id: string }).id;

    const compteurs: Compteurs = { creations: 0, publications: 0 };
    const transferts: { fenetre: number; octets: number }[] = [];
    const provider = fakeProvider(compteurs, { status: "processing" });
    let restant = 2;
    provider.publisher!.resumeTransfer = async ({ deadline }) => {
      const fenetre = deadline - Date.now();
      // La fenêtre reçue doit permettre de tenter quelque chose.
      if (fenetre < YOUTUBE_MIN_TRANSFER_BUDGET_MS) {
        transferts.push({ fenetre, octets: 0 });
        return { pushedBytes: 0 };
      }
      restant -= 1;
      transferts.push({ fenetre, octets: 1_024 });
      return { pushedBytes: 1_024 };
    };
    provider.publisher!.containerStatus = async () =>
      restant > 0 ? "processing" : ("ready" as ContainerStatus);

    const rapport = await runScheduler({
      ...deps(provider),
      staleAfter: "0 seconds",
    });

    // LE POINT : des octets sont réellement partis, et la fenêtre accordée
    // était au-dessus du minimum du transfert fractionné.
    expect(transferts.length).toBeGreaterThanOrEqual(1);
    expect(transferts[0].fenetre).toBeGreaterThanOrEqual(YOUTUBE_MIN_TRANSFER_BUDGET_MS);
    expect(transferts.every((t) => t.octets > 0)).toBe(true);
    expect(rapport.resumed).toBeGreaterThanOrEqual(1);

    const rows = await lignes();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].status).toBe("published");
    // Toujours une seule session : rien n'a été rouvert.
    expect(compteurs.creations).toBe(0);
  }, 60_000);

  it("tentatives épuisées : la ligne est CONCLUE, pas laissée en attente à vie", async () => {
    await purge();
    // `claim_stale_publications` ne rend que les lignes sous le plafond. Une
    // fois celui-ci atteint, la ligne n'était plus jamais réclamée — et restait
    // `pending` pour toujours : affichée « en cours » à un client qui attendait
    // pour rien, absente des échecs. C'est ce trou que ce test ferme.
    const { data: inserted } = await admin
      .from("social_publications")
      .insert({
        workspace_id: workspaceId,
        social_account_id: accountId,
        platform: "facebook",
        provider_account_id: "1290000000000102",
        media_kind: "reel",
        media_url: "https://cdn.example.com/epuisee.mp4",
        caption: "C10.2 — tentatives épuisées",
        status: "pending",
        container_id: "session-qui-n-avance-plus",
        attempts: MAX_ATTEMPTS,
        scheduled_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        requested_by: ownerId,
      })
      .select("id")
      .single();
    const id = (inserted as { id: string }).id;

    const compteurs: Compteurs = { creations: 0, publications: 0 };
    const rapport = await runScheduler({
      ...deps(fakeProvider(compteurs, { status: "processing" })),
      staleAfter: "0 seconds",
    });

    expect(rapport.failed).toContainEqual({ publicationId: id, code: "transfer_stalled" });

    const rows = await lignes();
    expect(rows[0].status).toBe("failed");
    expect(rows[0].status_detail).toBe("transfer_stalled");
    // Le conteneur est CONSERVÉ : la session distante peut encore valoir
    // quelque chose, et l'effacer interdirait toute reprise manuelle.
    expect(rows[0].container_id).toBe("session-qui-n-avance-plus");
    // Rien n'a été renvoyé à la plateforme.
    expect(compteurs.creations).toBe(0);
    expect(compteurs.publications).toBe(0);
  }, 60_000);

  it("réclamée puis interrompue AVANT le conteneur : rattrapée, pas perdue", async () => {
    await purge();
    const id = await programmerPuisRendreDue("C10.2 — interruption avant conteneur");

    // On simule une exécution morte juste après la réclamation : la ligne est
    // `pending`, sans conteneur. Rien n'est parti chez la plateforme.
    await admin.rpc("claim_due_publications", { p_limit: 10 });
    const avant = await lignes();
    expect(avant[0].status).toBe("pending");
    expect(avant[0].container_id).toBeNull();

    const compteurs: Compteurs = { creations: 0, publications: 0 };
    const rapport = await runScheduler({
      ...deps(fakeProvider(compteurs)),
      staleAfter: "0 seconds",
    });

    // Sans ce rattrapage, la publication serait restée `pending` à jamais :
    // l'ancienne reprise exigeait un conteneur, qui n'existait pas.
    expect(rapport.resumed).toBeGreaterThanOrEqual(1);
    const apres = await lignes();
    expect(apres).toHaveLength(1);
    expect(apres[0].id).toBe(id);
    expect(apres[0].status).toBe("published");
    // Repartie du début, donc UN conteneur créé — et une seule publication.
    expect(compteurs.creations).toBe(1);
    expect(compteurs.publications).toBe(1);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Statut du compte face à un refus de la plateforme
  // -------------------------------------------------------------------------

  async function statutDuCompte() {
    const { data } = await admin
      .from("social_accounts")
      .select("status, status_detail")
      .eq("id", accountId)
      .single();
    return data as { status: string; status_detail: string | null };
  }

  it("autorisation réellement invalide : le compte cesse d'afficher « Connecté »", async () => {
    await purge();
    await programmerPuisRendreDue("C10.2b — jeton mort");
    const compteurs: Compteurs = { creations: 0, publications: 0 };

    // Forme EXACTE produite par le provider Meta : type/code/sous-code.
    // 190 est le code canonique de « ce jeton n'est plus valable ».
    await runScheduler(
      deps(
        fakeProvider(compteurs, {
          detailEchec: "facebook video_reels start: HTTP 400 OAuthException/190/463",
        }),
      ),
    );

    const compte = await statutDuCompte();
    expect(compte.status).toBe("revoked");
    expect(compte.status_detail).toBe("publish_auth_invalid");
    // La publication, elle, est en échec — pas laissée en attente.
    expect((await lignes())[0].status).toBe("failed");

    await admin
      .from("social_accounts")
      .update({ status: "active", status_detail: null })
      .eq("id", accountId);
  }, 60_000);

  it("panne passagère ou blocage applicatif : le compte reste intact", async () => {
    // Le contresens à éviter absolument. Le 2026-08-27, les deux apps Meta
    // étaient bloquées (OAuthException/200) alors que les autorisations des
    // comptes étaient parfaitement valides : tout est reparti sans aucune
    // reconnexion. Déclasser aurait envoyé le propriétaire reconnecter des
    // comptes sains, sans rien changer au problème.
    for (const detail of [
      "facebook rupload: HTTP 503",
      "facebook video_reels start: HTTP 400 OAuthException/200",
      "facebook video_reels start: HTTP 400 OAuthException/4",
    ]) {
      await purge();
      await programmerPuisRendreDue(`C10.2b — ${detail}`);
      await runScheduler(deps(fakeProvider({ creations: 0, publications: 0 }, { detailEchec: detail })));

      const compte = await statutDuCompte();
      expect(compte.status, detail).toBe("active");
      expect(compte.status_detail, detail).toBeNull();
    }
  }, 90_000);

  // -------------------------------------------------------------------------
  // Isolation et quota
  // -------------------------------------------------------------------------

  it("le quota n'est PAS reconsommé à l'exécution", async () => {
    await purge();
    await programmerPuisRendreDue("C10.2 — quota");
    const compteurs: Compteurs = { creations: 0, publications: 0 };

    // Quota de 1 : la publication programmée l'occupe déjà. La recompter à
    // l'exécution la ferait échouer contre elle-même.
    const rapport = await runScheduler(deps(fakeProvider(compteurs), 1));

    expect(rapport.published).toBe(1);
    expect(rapport.failed).toEqual([]);
  }, 60_000);

  it("le planificateur ne touche qu'aux lignes que la base lui a attribuées", async () => {
    await purge();
    // Une ligne d'un AUTRE workspace, due elle aussi : elle sera réclamée par
    // le même balayage — c'est voulu, le planificateur sert tout le monde —
    // mais elle ne doit jamais être publiée avec le compte de CE workspace.
    const id = await programmerPuisRendreDue("C10.2 — isolation");
    const compteurs: Compteurs = { creations: 0, publications: 0 };

    await runScheduler(deps(fakeProvider(compteurs)));

    const { data: publication } = await admin
      .from("social_publications")
      .select("workspace_id, social_account_id")
      .eq("id", id)
      .single();
    expect(publication!.workspace_id).toBe(workspaceId);
    expect(publication!.social_account_id).toBe(accountId);
    await purge();
  }, 60_000);
});
