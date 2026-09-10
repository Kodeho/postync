/**
 * Rétention YouTube — les chemins DESTRUCTIFS, contre la vraie base de staging.
 *
 * Ce que les suites existantes ne couvraient pas. `youtube-retention.test.ts`
 * éprouve la politique (fonctions pures) et `youtube-retention-flow.test.ts` le
 * câblage avec des doublures en mémoire : aucune des deux ne fait tourner la
 * passe contre une base réelle, donc ni `disconnect_social_account`, ni la
 * purge des publications, ni la protection des publications en vol n'avaient
 * jamais été exercées ailleurs qu'en simulation.
 *
 * ---------------------------------------------------------------------------
 * DEUX GARDE-FOUS, ET ILS NE SONT PAS DÉCORATIFS
 * ---------------------------------------------------------------------------
 *
 * 1. LA BASE. L'URL doit être EXACTEMENT celle du staging, et la référence de
 *    production est refusée nommément. Sur cette machine, `.env.local` pointe
 *    la PRODUCTION : sans ce contrôle, une suite qui purge des comptes s'y
 *    exécuterait. Non armée, elle est simplement ignorée.
 *
 * 2. LE PROVIDER. `getProvider` LÈVE si la passe le sollicite. La passe examine
 *    TOUS les comptes YouTube de la base, pas seulement les nôtres : si l'un
 *    d'eux devenait éligible à une relecture, un provider factice ferait tourner
 *    ses jetons Vault avec des valeurs inventées et casserait un compte réel.
 *    Lever transforme ce risque en échec bruyant. Les fixtures sont donc
 *    choisies pour que la passe n'ait JAMAIS à relire quoi que ce soit :
 *    `revoked` purge sans réseau, et une identité fraîche est conservée.
 *
 * `purgeStalePublications` n'est pas restreinte à un workspace — elle balaie
 * toutes les publications YouTube de plus de 30 jours. Vérifié avant écriture
 * de cette suite : le staging n'en portait aucune d'éligible.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runYouTubeRetention, type RetentionReport } from "@/server/social/retention";

const REF_STAGING = "illwldvbunnsublcoewg";
const URL_STAGING = `https://${REF_STAGING}.supabase.co`;
/** Jamais ici. Nommée pour que le refus soit lisible dans le rapport d'échec. */
const REF_PRODUCTION = "dklewvchwbmmmemnjrze";

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

/** `process.env` d'abord : c'est ainsi qu'un lanceur vise le staging. */
const fichier = loadEnvLocal();
function lire(nom: string): string {
  return (process.env[nom] ?? fichier[nom] ?? "").trim();
}

const URL_SUPABASE = lire("NEXT_PUBLIC_SUPABASE_URL");
const CLE_ANON = lire("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const CLE_SERVICE = lire("SUPABASE_SERVICE_ROLE_KEY");
const ARME = Boolean(URL_SUPABASE === URL_STAGING && CLE_ANON && CLE_SERVICE);

const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };
const EMAIL = "postync-c9r-owner@example.com";
const PASSWORD = `C9R-${randomUUID()}`;
/** Préfixe de toutes les données écrites ici. Sert aussi au nettoyage. */
const MARQUEUR = "TEST RETENTION";
const JOUR = 24 * 60 * 60 * 1000;

let admin: SupabaseClient;
let ownerId = "";
let workspaceId = "";
let rapport: RetentionReport;

const ids = {
  compteRevoque: "",
  compteNeuf: "",
  pubAncienne: "",
  pubEnVol: "",
  pubDuCompteRevoque: "",
};

/** Aucun provider ne doit être sollicité — voir l'en-tête, garde-fou 2. */
function providerInterdit(): never {
  throw new Error(
    "la passe a demandé un provider : une fixture rend un compte éligible à " +
      "la relecture, ce qui ferait tourner de vrais jetons avec des valeurs " +
      "inventées. Corriger la fixture avant de relancer.",
  );
}

async function creerCompte(input: {
  providerAccountId: string;
  displayName: string;
  status: string;
  connectedAt: string;
}): Promise<string> {
  const { data, error } = await admin
    .from("social_accounts")
    .insert({
      workspace_id: workspaceId,
      platform: "youtube",
      provider_account_id: input.providerAccountId,
      display_name: input.displayName,
      // Aucune contrainte vers Vault sur cette colonne, et le trigger de purge
      // tolère un identifiant absent : inutile de créer un vrai secret.
      access_token_id: randomUUID(),
      scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
      status: input.status,
      connected_at: input.connectedAt,
      connected_by: ownerId,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function creerPublication(input: {
  socialAccountId: string | null;
  caption: string;
  status: string;
  platformDataAt: string;
  containerId: string | null;
  providerMediaId: string | null;
  permalink: string | null;
}): Promise<string> {
  const { data, error } = await admin
    .from("social_publications")
    .insert({
      workspace_id: workspaceId,
      social_account_id: input.socialAccountId,
      platform: "youtube",
      provider_account_id: "UC-FIXTURE",
      media_kind: "video",
      media_url: "https://exemple.invalid/fixture.mp4",
      caption: input.caption,
      container_id: input.containerId,
      provider_media_id: input.providerMediaId,
      permalink: input.permalink,
      status: input.status,
      platform_data_at: input.platformDataAt,
      requested_by: ownerId,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function lirePublication(id: string) {
  const { data } = await admin
    .from("social_publications")
    .select(
      "id, caption, media_kind, media_url, status, provider_account_id, " +
        "provider_media_id, permalink, container_id, purged_at, platform_data_at",
    )
    .eq("id", id)
    .maybeSingle();
  return data as Record<string, unknown> | null;
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((u) => u.email === EMAIL)) {
    // Les publications et les comptes partent en cascade avec le workspace.
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!ARME)("Rétention YouTube — purges réelles (staging)", () => {
  beforeAll(async () => {
    // Garde-fou 1, avant toute connexion.
    expect(URL_SUPABASE, "la base visée doit être EXACTEMENT le staging").toBe(URL_STAGING);
    expect(
      URL_SUPABASE.includes(REF_PRODUCTION),
      "REFUS : cette URL est celle de la PRODUCTION",
    ).toBe(false);

    admin = createClient(URL_SUPABASE, CLE_SERVICE, NO_SESSION);
    await cleanup();

    const { data: user, error: userError } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "C9R Owner" },
    });
    if (userError) throw userError;
    ownerId = user.user.id;

    const owner = createClient(URL_SUPABASE, CLE_ANON, NO_SESSION);
    const { error: signInError } = await owner.auth.signInWithPassword({
      email: EMAIL,
      password: PASSWORD,
    });
    if (signInError) throw signInError;
    const { data: ws, error: wsError } = await owner.rpc("create_workspace", {
      p_name: "C9R Retention",
    });
    if (wsError) throw wsError;
    workspaceId = (ws as { id: string }).id;

    const maintenant = Date.now();
    const vieux = new Date(maintenant - 40 * JOUR).toISOString();

    // A — révoqué : `decideRetention` purge SANS aucun appel distant.
    ids.compteRevoque = await creerCompte({
      providerAccountId: "UC-TEST-RETENTION-REVOKED",
      displayName: `${MARQUEUR} revoque`,
      status: "revoked",
      connectedAt: new Date(maintenant).toISOString(),
    });
    // B — fraîchement connecté, `identity_refreshed_at` NUL : c'est l'état de
    // TOUT compte créé par `callback.ts`. Doit être conservé, pas purgé.
    ids.compteNeuf = await creerCompte({
      providerAccountId: "UC-TEST-RETENTION-FRESH",
      displayName: `${MARQUEUR} neuf`,
      status: "active",
      connectedAt: new Date(maintenant).toISOString(),
    });

    // C — publication terminale de plus de 30 jours : à purger.
    ids.pubAncienne = await creerPublication({
      socialAccountId: null,
      caption: `${MARQUEUR} - ancienne terminale`,
      status: "published",
      platformDataAt: vieux,
      containerId: "https://upload.invalid/session/ancienne",
      providerMediaId: "VID-ANCIENNE",
      permalink: "https://youtu.be/ANCIENNE",
    });
    // D — EN VOL, même ancienneté : ne doit PAS être touchée.
    ids.pubEnVol = await creerPublication({
      socialAccountId: null,
      caption: `${MARQUEUR} - en vol`,
      status: "scheduled",
      platformDataAt: vieux,
      containerId: "https://upload.invalid/session/envol",
      providerMediaId: null,
      permalink: null,
    });
    // E — récente, rattachée au compte révoqué : sert à prouver ce qui SURVIT
    // à la purge du compte.
    ids.pubDuCompteRevoque = await creerPublication({
      socialAccountId: ids.compteRevoque,
      caption: `${MARQUEUR} - du compte revoque`,
      status: "published",
      platformDataAt: new Date(maintenant).toISOString(),
      containerId: "https://upload.invalid/session/revoque",
      providerMediaId: "VID-REVOQUE",
      permalink: "https://youtu.be/REVOQUE",
    });

    rapport = await runYouTubeRetention({ db: admin, getProvider: providerInterdit });
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  it("la passe rapporte au moins une purge de compte et une de publication", () => {
    expect(rapport.purges).toBeGreaterThanOrEqual(1);
    expect(rapport.publicationsPurgees).toBeGreaterThanOrEqual(1);
    expect(rapport.sature).toBe(false);
  });

  it("le compte révoqué est supprimé", async () => {
    const { data } = await admin
      .from("social_accounts")
      .select("id")
      .eq("id", ids.compteRevoque)
      .maybeSingle();
    expect(data, "le compte révoqué aurait dû être purgé").toBeNull();
  });

  it("le compte fraîchement connecté (identité nulle) est CONSERVÉ", async () => {
    const { data } = await admin
      .from("social_accounts")
      .select("id, status, identity_refreshed_at")
      .eq("id", ids.compteNeuf)
      .maybeSingle();
    const ligne = data as { id: string; identity_refreshed_at: string | null } | null;
    expect(ligne, "un compte connecté aujourd'hui ne doit jamais être purgé").not.toBeNull();
    // Le repli de `decideRetention` sur `connected_at` est le chemin NORMAL
    // d'un compte récent : la colonne reste nulle tant qu'aucune relecture
    // n'a eu lieu. Retirer ce repli purgerait tout compte neuf.
    expect(ligne?.identity_refreshed_at).toBeNull();
  });

  it("une publication terminale de plus de 30 jours perd ses données de plateforme", async () => {
    const p = await lirePublication(ids.pubAncienne);
    expect(p?.provider_account_id).toBeNull();
    expect(p?.provider_media_id).toBeNull();
    expect(p?.permalink).toBeNull();
    expect(p?.container_id).toBeNull();
    expect(p?.purged_at, "purged_at doit horodater la purge").not.toBeNull();
    // Ce qui vient de l'utilisateur survit : l'historique garde son sens.
    expect(p?.caption).toBe(`${MARQUEUR} - ancienne terminale`);
    expect(p?.media_url).toBe("https://exemple.invalid/fixture.mp4");
    expect(p?.status).toBe("published");
  });

  it("une publication EN VOL n'est jamais touchée, container_id compris", async () => {
    const p = await lirePublication(ids.pubEnVol);
    // Effacer `container_id` d'une session résumable ferait rouvrir une
    // session au réveil suivant du planificateur, donc CRÉER UNE SECONDE VIDÉO.
    expect(p?.container_id).toBe("https://upload.invalid/session/envol");
    expect(p?.purged_at, "une publication en vol ne se purge pas").toBeNull();
    expect(p?.status).toBe("scheduled");
  });

  it("purger un compte efface ses données de plateforme mais garde le contenu", async () => {
    const p = await lirePublication(ids.pubDuCompteRevoque);
    expect(p?.provider_media_id).toBeNull();
    expect(p?.permalink).toBeNull();
    expect(p?.container_id).toBeNull();
    expect(p?.purged_at).not.toBeNull();
    expect(p?.caption).toBe(`${MARQUEUR} - du compte revoque`);
    expect(p?.media_kind).toBe("video");
  });
});
