/**
 * C11 — publication multi-réseaux, contre la VRAIE base.
 *
 * Ce que ces tests protègent, par ordre d'importance :
 *
 *   1. LE QUOTA EST VÉRIFIÉ POUR LE LOT ENTIER, avant d'envoyer quoi que ce
 *      soit. Un utilisateur à qui il reste deux publications et qui en demande
 *      trois ne doit pas en voir partir deux puis récolter un échec : deux
 *      contenus publiés qu'il n'a pas choisi de dissocier.
 *   2. UN ÉCHEC PARTIEL RESTE VISIBLE réseau par réseau. Publier sur trois
 *      dont un refuse ne ressemble ni à une réussite ni à un échec.
 *   3. CHAQUE RÉSEAU EST INDÉPENDANT : le refus de l'un n'empêche pas les
 *      autres de partir.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { finalizeUpload, requestUpload, type MediaDeps } from "@/server/media/library";
import {
  broadcastPublication,
  everyTargetFailed,
  isPartialSuccess,
  type BroadcastDeps,
} from "@/server/social/broadcast";
import { countPublicationsThisMonth } from "@/server/social/queries";
import type { ContainerStatus, SocialProvider } from "@/server/social/providers/types";
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
const PASSWORD = `C11-${randomUUID()}`;
const EMAIL = "postync-c11-owner@example.com";
const OCTETS = new Uint8Array(4096).fill(7);

let admin: SupabaseClient;
let ownerId = "";
let workspaceId = "";
/** Deux comptes publiables, sur deux réseaux différents. */
let facebookId = "";
let instagramId = "";
let mediaAssetId = "";

type Compteurs = { facebook: number; instagram: number };

function providerPour(
  plateforme: "facebook" | "instagram",
  compteurs: Compteurs,
  options: { echouer?: boolean; status?: ContainerStatus } = {},
): SocialProvider {
  return {
    platform: plateforme,
    usesPkce: false,
    buildAuthUrl: () => "https://example.invalid",
    exchangeCode: async () => {
      throw new Error("non utilisé");
    },
    publisher: {
      requiredScopes: [],
      supportedMediaKinds: ["reel"] as const,
      async createContainer() {
        if (options.echouer) throw new Error("refus simulé");
        return `container-${plateforme}`;
      },
      async containerStatus(): Promise<ContainerStatus> {
        return options.status ?? "ready";
      },
      async publishContainer() {
        compteurs[plateforme] += 1;
        return { providerMediaId: `media-${plateforme}-${compteurs[plateforme]}` };
      },
      async fetchPermalink() {
        return `https://example.invalid/${plateforme}`;
      },
    },
  } as unknown as SocialProvider;
}

function deps(
  compteurs: Compteurs,
  quota = 100,
  options: { echouerSur?: "facebook" | "instagram"; status?: ContainerStatus } = {},
): BroadcastDeps {
  return {
    db: admin,
    getProvider: (p) =>
      p === "facebook" || p === "instagram"
        ? providerPour(p, compteurs, {
            echouer: options.echouerSur === p,
            status: options.status,
          })
        : null,
    getMonthlyQuota: async () => quota,
    countUsedThisMonth: (ws, month) => countPublicationsThisMonth(admin, ws, month),
    sleep: async () => undefined,
    // Sans borne, l'attente du conteneur tournerait à vide pendant tout le
    // budget réel : 13 secondes pour un test qui n'attend rien.
    pollBudgetMs: 50,
  };
}

const mediaDeps: MediaDeps = {
  get db() {
    return admin;
  },
  getStorageQuotaGb: async () => 5,
};

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((u) => u.email === EMAIL)) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C11 — publication multi-réseaux", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "C11 Owner" },
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
    const { data: ws, error: wsError } = await anon.rpc("create_workspace", { p_name: "C11 WS" });
    if (wsError) throw wsError;
    workspaceId = (ws as { id: string }).id;

    for (const [plateforme, ref] of [
      ["facebook", "fb"],
      ["instagram", "ig"],
    ] as const) {
      const tokenId = await vaultStore(admin, `jeton-${ref}-c11`, `c11/${ref}`);
      const { data: compte, error: accError } = await admin
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: plateforme,
          provider_account_id: `c11-${ref}`,
          display_name: `Compte ${plateforme}`,
          access_token_id: tokenId,
          scopes: [],
          connected_by: ownerId,
        })
        .select("id")
        .single();
      if (accError) throw accError;
      if (plateforme === "facebook") facebookId = (compte as { id: string }).id;
      else instagramId = (compte as { id: string }).id;
    }

    // Un média réel, mesuré comme 9:16 : compatible avec les deux réseaux.
    const demande = await requestUpload(mediaDeps, {
      workspaceId,
      userId: ownerId,
      filename: "c11.mp4",
      mimeType: "video/mp4",
      byteSize: OCTETS.length,
    });
    if (!demande.ok) throw new Error("upload refusé");
    await fetch(demande.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "video/mp4" },
      body: OCTETS,
    });
    await finalizeUpload(admin, {
      workspaceId,
      assetId: demande.assetId,
      probe: { width: 720, height: 1280, durationSeconds: 20, videoCodec: "avc1", fastStart: true },
    });
    mediaAssetId = demande.assetId;
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  async function purge() {
    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  }

  function requete(overrides: Record<string, unknown> = {}) {
    return {
      workspaceId,
      requestedBy: ownerId,
      mediaKind: "reel" as const,
      mediaAssetId,
      caption: "C11",
      socialAccountIds: [facebookId, instagramId],
      scheduledAt: null,
      ...overrides,
    };
  }

  async function lignes() {
    const { data } = await admin
      .from("social_publications")
      .select("id, platform, status, provider_media_id, scheduled_at")
      .eq("workspace_id", workspaceId);
    return data ?? [];
  }

  // -------------------------------------------------------------------------
  // Le parcours nominal
  // -------------------------------------------------------------------------

  it("publie sur les DEUX réseaux, une ligne par réseau", async () => {
    await purge();
    const compteurs: Compteurs = { facebook: 0, instagram: 0 };

    const outcome = await broadcastPublication(deps(compteurs), requete());
    if (!outcome.ok) throw new Error(`refusé : ${outcome.code}`);

    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every((r) => r.status === "published")).toBe(true);
    expect(compteurs).toEqual({ facebook: 1, instagram: 1 });

    const rows = await lignes();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.platform))).toEqual(new Set(["facebook", "instagram"]));
    // Deux identifiants distants DISTINCTS : rien n'a été publié deux fois.
    expect(new Set(rows.map((r) => r.provider_media_id)).size).toBe(2);
  }, 60_000);

  it("sélectionner deux fois le même compte ne publie qu'une fois", async () => {
    await purge();
    const compteurs: Compteurs = { facebook: 0, instagram: 0 };

    const outcome = await broadcastPublication(
      deps(compteurs),
      requete({ socialAccountIds: [facebookId, facebookId, facebookId] }),
    );
    if (!outcome.ok) throw new Error("refusé");

    expect(outcome.results).toHaveLength(1);
    expect(compteurs.facebook).toBe(1);
    expect(await lignes()).toHaveLength(1);
  }, 60_000);

  it("programme sur les deux réseaux sans rien publier tout de suite", async () => {
    await purge();
    const compteurs: Compteurs = { facebook: 0, instagram: 0 };
    const echeance = new Date(Date.now() + 3600_000).toISOString();

    const outcome = await broadcastPublication(
      deps(compteurs),
      requete({ scheduledAt: echeance }),
    );
    if (!outcome.ok) throw new Error("refusé");

    expect(outcome.results.every((r) => r.status === "scheduled")).toBe(true);
    // AUCUN appel distant : programmer ne publie pas.
    expect(compteurs).toEqual({ facebook: 0, instagram: 0 });

    const rows = await lignes();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "scheduled")).toBe(true);
    expect(rows.every((r) => r.scheduled_at !== null)).toBe(true);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Le quota, vérifié pour le LOT
  // -------------------------------------------------------------------------

  it("quota insuffisant pour le lot : RIEN n'est publié", async () => {
    await purge();
    const compteurs: Compteurs = { facebook: 0, instagram: 0 };

    // Quota de 1, deux réseaux demandés.
    const outcome = await broadcastPublication(deps(compteurs, 1), requete());

    expect(outcome).toEqual({ ok: false, code: "quota_exceeded", remaining: 1 });
    // LE POINT : aucun appel distant, aucune ligne. Publier une seule des deux
    // cibles dissocierait un contenu que l'utilisateur voulait simultané.
    expect(compteurs).toEqual({ facebook: 0, instagram: 0 });
    expect(await lignes()).toHaveLength(0);
  }, 60_000);

  it("le quota tient compte de ce qui est DÉJÀ publié ce mois-ci", async () => {
    await purge();
    const compteurs: Compteurs = { facebook: 0, instagram: 0 };

    // Une première diffusion consomme 2 sur un quota de 3.
    const premier = await broadcastPublication(deps(compteurs, 3), requete());
    expect(premier.ok).toBe(true);

    // Il n'en reste qu'une : deux cibles sont refusées…
    const refus = await broadcastPublication(deps(compteurs, 3), requete());
    expect(refus).toEqual({ ok: false, code: "quota_exceeded", remaining: 1 });

    // …mais une seule passe.
    const derniere = await broadcastPublication(
      deps(compteurs, 3),
      requete({ socialAccountIds: [facebookId] }),
    );
    expect(derniere.ok).toBe(true);
    expect(await lignes()).toHaveLength(3);
  }, 90_000);

  it("aucune cible, ou trop de cibles : refus net", async () => {
    await purge();
    const compteurs: Compteurs = { facebook: 0, instagram: 0 };

    expect(
      await broadcastPublication(deps(compteurs), requete({ socialAccountIds: [] })),
    ).toEqual({ ok: false, code: "no_target" });

    const beaucoup = Array.from({ length: 25 }, () => randomUUID());
    expect(
      await broadcastPublication(deps(compteurs), requete({ socialAccountIds: beaucoup })),
    ).toEqual({ ok: false, code: "too_many_targets" });

    expect(await lignes()).toHaveLength(0);
  }, 60_000);

  it("échéance invalide : refus avant tout envoi", async () => {
    await purge();
    const compteurs: Compteurs = { facebook: 0, instagram: 0 };

    for (const echeance of ["pas une date", new Date(Date.now() + 60_000).toISOString()]) {
      expect(
        await broadcastPublication(deps(compteurs), requete({ scheduledAt: echeance })),
        echeance,
      ).toEqual({ ok: false, code: "schedule_invalid" });
    }
    expect(await lignes()).toHaveLength(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // L'échec partiel
  // -------------------------------------------------------------------------

  it("un réseau refuse : l'autre part quand même, et le détail le dit", async () => {
    await purge();
    const compteurs: Compteurs = { facebook: 0, instagram: 0 };

    const outcome = await broadcastPublication(
      deps(compteurs, 100, { echouerSur: "facebook" }),
      requete(),
    );
    if (!outcome.ok) throw new Error("refusé");

    const parCompte = new Map(outcome.results.map((r) => [r.socialAccountId, r]));
    expect(parCompte.get(facebookId)!.status).toBe("failed");
    expect(parCompte.get(instagramId)!.status).toBe("published");

    // Instagram est parti malgré le refus de Facebook : les réseaux sont
    // indépendants.
    expect(compteurs).toEqual({ facebook: 0, instagram: 1 });

    // Et le résultat est reconnaissable comme PARTIEL.
    expect(isPartialSuccess(outcome.results)).toBe(true);
    expect(everyTargetFailed(outcome.results)).toBe(false);

    const rows = await lignes();
    expect(rows.find((r) => r.platform === "facebook")!.status).toBe("failed");
    expect(rows.find((r) => r.platform === "instagram")!.status).toBe("published");
  }, 60_000);

  it("un compte d'un AUTRE workspace est refusé, sans toucher aux autres", async () => {
    await purge();
    const compteurs: Compteurs = { facebook: 0, instagram: 0 };

    const outcome = await broadcastPublication(
      deps(compteurs),
      requete({ socialAccountIds: [facebookId, randomUUID()] }),
    );
    if (!outcome.ok) throw new Error("refusé");

    const echecs = outcome.results.filter((r) => r.status === "failed");
    expect(echecs).toHaveLength(1);
    expect(echecs[0].code).toBe("account_not_found");
    expect(compteurs.facebook).toBe(1);
    expect(await lignes()).toHaveLength(1);
  }, 60_000);

  it("conteneur pas prêt : la ligne reste reprenable, ce n'est pas un échec", async () => {
    await purge();
    const compteurs: Compteurs = { facebook: 0, instagram: 0 };

    const outcome = await broadcastPublication(
      deps(compteurs, 100, { status: "processing" }),
      requete({ socialAccountIds: [facebookId] }),
    );
    if (!outcome.ok) throw new Error("refusé");

    expect(outcome.results[0].status).toBe("pending");
    expect(everyTargetFailed(outcome.results)).toBe(false);
    // Le planificateur la reprendra : le média n'aura pas à être renvoyé.
    expect((await lignes())[0].status).toBe("pending");
    await purge();
  }, 60_000);
});
