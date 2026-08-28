/**
 * C10.1 — planification des publications, contre la VRAIE base.
 *
 * Deux choses sont éprouvées ici, et elles n'ont pas le même poids.
 *
 * La validation à la saisie est du confort : elle évite de découvrir un
 * problème à l'échéance.
 *
 * La RÉCLAMATION, elle, est critique. Si deux exécutions du planificateur
 * réclamaient la même publication, elle partirait deux fois sur un réseau
 * social — une erreur publique et irrattrapable. C'est le seul endroit du
 * produit où une transition d'état doit être prouvée atomique, et c'est ce
 * que fait le test « deux appels concurrents ».
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PublishDeps } from "@/server/social/publish";
import {
  MIN_LEAD_TIME_MS,
  cancelScheduledPublication,
  reschedulePublication,
  schedulePublication,
  validateScheduledAt,
} from "@/server/social/schedule";
import type { SocialProvider } from "@/server/social/providers/types";
import { countPublicationsThisMonth } from "@/server/social/queries";
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
const PASSWORD = `C10-${randomUUID()}`;
const EMAIL = "postync-c10-owner@example.com";

let admin: SupabaseClient;
/** Client SOUS SESSION : RLS et liste blanche de colonnes réellement en jeu. */
let ownerClient: SupabaseClient;
let ownerId = "";
let workspaceId = "";
let accountId = "";

/** Provider minimal : la planification n'appelle aucune plateforme. */
function fakeProvider(): SocialProvider {
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
    },
  } as unknown as SocialProvider;
}

function deps(quota = 100): PublishDeps {
  return {
    db: admin,
    getProvider: (p) => (p === "facebook" ? fakeProvider() : null),
    getMonthlyQuota: async () => quota,
    sleep: async () => undefined,
  };
}

const DANS_UNE_HEURE = () => new Date(Date.now() + 3600_000).toISOString();

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((u) => u.email === EMAIL)) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C10.1 — planification", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "C10 Owner" },
    });
    if (error) throw error;
    ownerId = data.user.id;

    ownerClient = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NO_SESSION,
    );
    const { error: e } = await ownerClient.auth.signInWithPassword({
      email: EMAIL,
      password: PASSWORD,
    });
    if (e) throw e;
    const { data: ws, error: wsError } = await ownerClient.rpc("create_workspace", {
      p_name: "C10 WS",
    });
    if (wsError) throw wsError;
    workspaceId = (ws as { id: string }).id;

    const tokenId = await vaultStore(admin, "EAA.page-c10", "c10/access");
    const { data: account, error: accError } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "facebook",
        provider_account_id: "1290000000000010",
        display_name: "Page C10",
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

  // -------------------------------------------------------------------------
  // Échéance
  // -------------------------------------------------------------------------

  it("refuse une échéance absurde, trop proche ou trop lointaine", () => {
    const maintenant = Date.now();
    expect(validateScheduledAt("pas une date", maintenant)).toEqual({
      ok: false,
      code: "schedule_invalid",
    });
    expect(validateScheduledAt(new Date(maintenant - 60_000).toISOString(), maintenant)).toEqual({
      ok: false,
      code: "schedule_too_soon",
    });
    // Juste sous la marge : refusé. Juste au-dessus : accepté.
    expect(
      validateScheduledAt(new Date(maintenant + MIN_LEAD_TIME_MS - 1000).toISOString(), maintenant),
    ).toEqual({ ok: false, code: "schedule_too_soon" });
    expect(
      validateScheduledAt(new Date(maintenant + MIN_LEAD_TIME_MS + 1000).toISOString(), maintenant)
        .ok,
    ).toBe(true);
    expect(
      validateScheduledAt(
        new Date(maintenant + 400 * 24 * 3600 * 1000).toISOString(),
        maintenant,
      ),
    ).toEqual({ ok: false, code: "schedule_too_far" });
  });

  // -------------------------------------------------------------------------
  // Contrôles à la saisie
  // -------------------------------------------------------------------------

  it("programme une publication valide et la laisse en attente d'échéance", async () => {
    await purge();
    const echeance = DANS_UNE_HEURE();
    const result = await schedulePublication(deps(), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/planifie.mp4",
      caption: "Programmée",
      scheduledAt: echeance,
    });
    expect(result.ok).toBe(true);

    const { data: row } = await admin
      .from("social_publications")
      .select("status, scheduled_at, effective_at, attempts, caption")
      .eq("workspace_id", workspaceId)
      .single();
    expect(row!.status).toBe("scheduled");
    expect(new Date(row!.scheduled_at as string).toISOString()).toBe(echeance);
    expect(row!.attempts).toBe(0);
    // La colonne générée suit l'échéance, pas la création.
    expect(new Date(row!.effective_at as string).toISOString()).toBe(echeance);
  }, 60_000);

  it("refuse un compte d'un autre workspace, inactif, ou sans le scope requis", async () => {
    await purge();
    const base = {
      workspaceId,
      requestedBy: ownerId,
      mediaKind: "reel" as const,
      mediaUrl: "https://cdn.example.com/x.mp4",
      caption: null,
      scheduledAt: DANS_UNE_HEURE(),
    };

    expect(
      await schedulePublication(deps(), { ...base, socialAccountId: randomUUID() }),
    ).toEqual({ ok: false, code: "account_not_found" });

    await admin.from("social_accounts").update({ status: "revoked" }).eq("id", accountId);
    expect(await schedulePublication(deps(), { ...base, socialAccountId: accountId })).toEqual({
      ok: false,
      code: "account_inactive",
    });
    await admin.from("social_accounts").update({ status: "active" }).eq("id", accountId);

    // Scope retiré : la planification doit refuser MAINTENANT plutôt que de
    // laisser l'échéance échouer silencieusement.
    await admin.from("social_accounts").update({ scopes: ["pages_show_list"] }).eq("id", accountId);
    expect(await schedulePublication(deps(), { ...base, socialAccountId: accountId })).toEqual({
      ok: false,
      code: "missing_scope",
    });
    await admin
      .from("social_accounts")
      .update({ scopes: ["pages_manage_posts"] })
      .eq("id", accountId);

    const { count } = await admin
      .from("social_publications")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    expect(count).toBe(0);
  }, 60_000);

  it("le quota compte le mois de l'ÉCHÉANCE, pas celui de la saisie", async () => {
    await purge();
    const base = {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel" as const,
      mediaUrl: "https://cdn.example.com/q.mp4",
      caption: null,
    };

    // Quota de 1. Une publication programmée ce mois-ci le consomme…
    const premier = await schedulePublication(deps(1), {
      ...base,
      scheduledAt: DANS_UNE_HEURE(),
    });
    expect(premier.ok).toBe(true);

    // …donc une seconde pour le MÊME mois est refusée.
    expect(await schedulePublication(deps(1), { ...base, scheduledAt: DANS_UNE_HEURE() })).toEqual({
      ok: false,
      code: "quota_exceeded",
    });

    // …mais une échéance le mois suivant relève d'un autre quota.
    const moisSuivant = new Date();
    moisSuivant.setUTCMonth(moisSuivant.getUTCMonth() + 1, 15);
    const suivante = await schedulePublication(deps(1), {
      ...base,
      scheduledAt: moisSuivant.toISOString(),
    });
    expect(suivante.ok).toBe(true);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Réclamation — le point critique
  // -------------------------------------------------------------------------

  it("deux appels concurrents ne réclament JAMAIS la même publication", async () => {
    await purge();
    // Trois échéances dues. Les dates sont posées directement : la validation
    // interdit — à raison — de programmer dans le passé.
    for (let i = 0; i < 3; i += 1) {
      await admin.from("social_publications").insert({
        workspace_id: workspaceId,
        social_account_id: accountId,
        platform: "facebook",
        provider_account_id: "1290000000000010",
        media_kind: "reel",
        media_url: `https://cdn.example.com/due-${i}.mp4`,
        status: "scheduled",
        scheduled_at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
        requested_by: ownerId,
      });
    }

    // Lancés ENSEMBLE, sans attendre l'un l'autre : c'est la seule façon
    // d'éprouver réellement la concurrence.
    await Promise.all([
      admin.rpc("claim_due_publications", { p_limit: 10 }),
      admin.rpc("claim_due_publications", { p_limit: 10 }),
    ]);

    // L'assertion porte sur l'ÉTAT des lignes de ce workspace, pas sur ce que
    // tel appel a renvoyé. La base est partagée et le planificateur balaie
    // tous les workspaces par conception : une autre suite peut légitimement
    // réclamer ces lignes en même temps.
    //
    // C'est d'ailleurs plus fort. `attempts` n'est incrémenté QUE par une
    // réclamation réussie : le trouver à 1 sur chaque ligne prouve que chacune
    // a été réclamée exactement une fois — quel que soit le nombre
    // d'appelants, et même entre processus distincts.
    const { data: apres } = await admin
      .from("social_publications")
      .select("status, attempts")
      .eq("workspace_id", workspaceId);
    expect(apres).toHaveLength(3);
    expect(apres!.every((r) => r.attempts === 1)).toBe(true);
    // Le STATUT, lui, a pu avancer : un autre réclamant légitime peut avoir
    // mené la publication plus loin. Ce qui est interdit, c'est qu'une ligne
    // reste `scheduled` — elle aurait alors échappé aux deux appels — ou
    // qu'elle porte plus d'une réclamation.
    expect(apres!.some((r) => r.status === "scheduled")).toBe(false);
  }, 60_000);

  it("une échéance future n'est pas réclamée", async () => {
    await purge();
    await schedulePublication(deps(), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/futur.mp4",
      caption: null,
      scheduledAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    });

    const { data } = await admin.rpc("claim_due_publications", { p_limit: 10 });
    const reclamees = (data ?? []) as { id: string }[];
    // La base est partagée : on vérifie qu'AUCUNE ligne de CE workspace n'a
    // bougé, plutôt que de supposer la table vide.
    const { data: apres } = await admin
      .from("social_publications")
      .select("id, status")
      .eq("workspace_id", workspaceId);
    expect(apres!.every((r) => r.status === "scheduled")).toBe(true);
    expect(reclamees.map((r) => r.id)).not.toContain(apres![0].id);
  }, 60_000);

  it("épuisement des tentatives : marquée en échec, plus jamais reprise", async () => {
    await purge();
    const { data: inserted } = await admin
      .from("social_publications")
      .insert({
        workspace_id: workspaceId,
        social_account_id: accountId,
        platform: "facebook",
        provider_account_id: "1290000000000010",
        media_kind: "reel",
        media_url: "https://cdn.example.com/epuisee.mp4",
        status: "scheduled",
        scheduled_at: new Date(Date.now() - 60_000).toISOString(),
        attempts: 3,
        requested_by: ownerId,
      })
      .select("id")
      .single();
    const id = (inserted as { id: string }).id;

    const { data } = await admin.rpc("claim_due_publications", { p_limit: 10 });
    expect(((data ?? []) as { id: string }[]).map((r) => r.id)).not.toContain(id);

    const { data: apres } = await admin
      .from("social_publications")
      .select("status, status_detail")
      .eq("id", id)
      .single();
    expect(apres!.status).toBe("failed");
    expect(apres!.status_detail).toBe("too_many_attempts");
  }, 60_000);

  // -------------------------------------------------------------------------
  // Comptage vu par l'UTILISATEUR
  // -------------------------------------------------------------------------

  it("le compteur affiché fonctionne SOUS SESSION, malgré la liste blanche de colonnes", async () => {
    // Régression réelle du 2026-08-27 : `countPublicationsThisMonth` comptait
    // avec `select("*")`. La table étant protégée par une liste blanche de
    // colonnes, `*` exige un droit sur TOUTES les colonnes — l'ajout de
    // `attempts`, volontairement non accordée, faisait échouer la requête.
    // `count` valait null, le compteur affichait 0, et le même motif servait
    // aux contrôles de quota : `(count ?? 0) >= quota` n'aurait plus jamais
    // bloqué personne.
    //
    // Aucun test ne l'a vu parce qu'ils utilisaient tous service_role, qui a
    // TOUS les droits. Celui-ci passe par une vraie session.
    await purge();
    await schedulePublication(deps(), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/comptee.mp4",
      caption: null,
      scheduledAt: DANS_UNE_HEURE(),
    });

    const vuParUtilisateur = await countPublicationsThisMonth(ownerClient, workspaceId);
    expect(vuParUtilisateur).toBe(1);

    // Et une annulation la retire du décompte : on ne facture pas un renoncement.
    const { data: row } = await admin
      .from("social_publications")
      .select("id")
      .eq("workspace_id", workspaceId)
      .single();
    await cancelScheduledPublication(admin, {
      workspaceId,
      publicationId: (row as { id: string }).id,
    });
    expect(await countPublicationsThisMonth(ownerClient, workspaceId)).toBe(0);
    await purge();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Annulation
  // -------------------------------------------------------------------------

  it("annule une publication encore programmée, refuse d'annuler une publication déjà partie", async () => {
    await purge();
    const result = await schedulePublication(deps(), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/annulable.mp4",
      caption: null,
      scheduledAt: DANS_UNE_HEURE(),
    });
    if (!result.ok) throw new Error("planification refusée");

    expect(
      await cancelScheduledPublication(admin, {
        workspaceId,
        publicationId: result.publicationId,
      }),
    ).toEqual({ ok: true });

    const { data: row } = await admin
      .from("social_publications")
      .select("status, status_detail")
      .eq("id", result.publicationId)
      .single();
    expect(row!.status).toBe("canceled");
    expect(row!.status_detail).toBe("canceled_by_user");

    // Déjà réclamée : POSTYNC ne prétend pas pouvoir la rattraper.
    await admin
      .from("social_publications")
      .update({ status: "pending" })
      .eq("id", result.publicationId);
    expect(
      await cancelScheduledPublication(admin, {
        workspaceId,
        publicationId: result.publicationId,
      }),
    ).toEqual({ ok: false, code: "already_started" });
  }, 60_000);

  it("un autre workspace ne peut pas annuler la publication d'autrui", async () => {
    await purge();
    const result = await schedulePublication(deps(), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/isolee.mp4",
      caption: null,
      scheduledAt: DANS_UNE_HEURE(),
    });
    if (!result.ok) throw new Error("planification refusée");

    expect(
      await cancelScheduledPublication(admin, {
        workspaceId: randomUUID(),
        publicationId: result.publicationId,
      }),
    ).toEqual({ ok: false, code: "not_found" });

    const { data: row } = await admin
      .from("social_publications")
      .select("status")
      .eq("id", result.publicationId)
      .single();
    expect(row!.status).toBe("scheduled");
    await purge();
  }, 60_000);
  // -------------------------------------------------------------------------
  // Déplacement d'échéance
  // -------------------------------------------------------------------------

  it("déplace l'échéance sans rien changer d'autre à la publication", async () => {
    await purge();
    const result = await schedulePublication(deps(), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/deplacee.mp4",
      caption: "Texte à conserver",
      scheduledAt: DANS_UNE_HEURE(),
    });
    if (!result.ok) throw new Error("planification refusée");

    const { data: avant } = await admin
      .from("social_publications")
      .select("caption, media_url, social_account_id, status, scheduled_at")
      .eq("id", result.publicationId)
      .single();

    const nouvelle = new Date(Date.now() + 5 * 3600_000).toISOString();
    const deplacement = await reschedulePublication(admin, {
      workspaceId,
      publicationId: result.publicationId,
      scheduledAt: nouvelle,
    });
    expect(deplacement).toEqual({ ok: true, scheduledAt: nouvelle });

    const { data: apres } = await admin
      .from("social_publications")
      .select("caption, media_url, social_account_id, status, scheduled_at")
      .eq("id", result.publicationId)
      .single();

    // L'échéance bouge…
    expect(apres!.scheduled_at).not.toBe(avant!.scheduled_at);
    expect(Date.parse(apres!.scheduled_at)).toBe(Date.parse(nouvelle));
    // …et RIEN d'autre. C'est tout l'intérêt : sans cela, il faudrait annuler
    // puis tout ressaisir.
    expect(apres!.caption).toBe(avant!.caption);
    expect(apres!.media_url).toBe(avant!.media_url);
    expect(apres!.social_account_id).toBe(avant!.social_account_id);
    expect(apres!.status).toBe("scheduled");
    await purge();
  }, 60_000);

  it("refuse une échéance trop proche, trop lointaine ou invalide", async () => {
    await purge();
    const result = await schedulePublication(deps(), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/bornes.mp4",
      caption: null,
      scheduledAt: DANS_UNE_HEURE(),
    });
    if (!result.ok) throw new Error("planification refusée");

    const base = { workspaceId, publicationId: result.publicationId };
    // Les mêmes bornes qu'à la création : une échéance déplacée dans le passé
    // ne serait pas plus tenable qu'une échéance créée dans le passé.
    expect(
      await reschedulePublication(admin, { ...base, scheduledAt: new Date(Date.now() + 60_000).toISOString() }),
    ).toEqual({ ok: false, code: "schedule_too_soon" });
    expect(
      await reschedulePublication(admin, {
        ...base,
        scheduledAt: new Date(Date.now() + 400 * 24 * 3600_000).toISOString(),
      }),
    ).toEqual({ ok: false, code: "schedule_too_far" });
    expect(
      await reschedulePublication(admin, { ...base, scheduledAt: "pas-une-date" }),
    ).toEqual({ ok: false, code: "schedule_invalid" });

    // L'échéance d'origine est intacte après ces trois refus.
    const { data: row } = await admin
      .from("social_publications")
      .select("status")
      .eq("id", result.publicationId)
      .single();
    expect(row!.status).toBe("scheduled");
    await purge();
  }, 60_000);

  it("refuse de déplacer une publication déjà réclamée par le planificateur", async () => {
    await purge();
    const result = await schedulePublication(deps(), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/reclamee.mp4",
      caption: null,
      scheduledAt: DANS_UNE_HEURE(),
    });
    if (!result.ok) throw new Error("planification refusée");

    // Le planificateur l'a prise en charge : elle est peut-être déjà partie
    // chez la plateforme. Déplacer son échéance ne la rappellerait pas, cela
    // ferait seulement mentir le calendrier.
    await admin
      .from("social_publications")
      .update({ status: "pending" })
      .eq("id", result.publicationId);

    expect(
      await reschedulePublication(admin, {
        workspaceId,
        publicationId: result.publicationId,
        scheduledAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
      }),
    ).toEqual({ ok: false, code: "already_started" });
    await purge();
  }, 60_000);

  it("un autre workspace ne peut pas déplacer la publication d'autrui", async () => {
    await purge();
    const result = await schedulePublication(deps(), {
      workspaceId,
      socialAccountId: accountId,
      requestedBy: ownerId,
      mediaKind: "reel",
      mediaUrl: "https://cdn.example.com/isolee-deplacement.mp4",
      caption: null,
      scheduledAt: DANS_UNE_HEURE(),
    });
    if (!result.ok) throw new Error("planification refusée");

    const avant = await admin
      .from("social_publications")
      .select("scheduled_at")
      .eq("id", result.publicationId)
      .single();

    expect(
      await reschedulePublication(admin, {
        workspaceId: randomUUID(),
        publicationId: result.publicationId,
        scheduledAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
      }),
    ).toEqual({ ok: false, code: "not_found" });

    const apres = await admin
      .from("social_publications")
      .select("scheduled_at")
      .eq("id", result.publicationId)
      .single();
    expect(apres.data!.scheduled_at).toBe(avant.data!.scheduled_at);
    await purge();
  }, 60_000);
});
