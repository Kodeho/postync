/**
 * C8.1 — Server Actions des comptes sociaux : autorisations réelles (JWT
 * réels, RLS réelle), déconnexion avec purge Vault, isolation inter-workspaces.
 * Même montage que les tests checkout C7 (client serveur remplacé par le
 * client réel de l'acteur ; tout le reste est authentique).
 */
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const env = await vi.hoisted(async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const file = resolve(process.cwd(), ".env.local");
  const vars: Record<string, string> = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(new RegExp("\\r?\\n"))) {
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (vars[key]) process.env[key] = vars[key];
  }
  return vars;
});

let currentActor: SupabaseClient;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentActor,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { disconnectAction, startConnectAction } from "@/server/social/actions";
import { IDLE_SOCIAL_ACTION } from "@/server/social/action-state";
import { listPublicationsForMonth } from "@/server/social/calendar";
import { listOverviewPublications } from "@/server/social/overview";
import { listRecentPublications } from "@/server/social/queries";
import { vaultRead, vaultStore } from "@/server/social/vault";

const CONFIGURED = Boolean(
  env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY,
);
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };
const PASSWORD = `C81a-${randomUUID()}`;
const USERS = {
  owner: "postync-c81a-owner@example.com",
  member: "postync-c81a-member@example.com",
  outsider: "postync-c81a-outsider@example.com",
} as const;
type Key = keyof typeof USERS;

let admin: SupabaseClient;
const ids: Record<Key, string> = { owner: "", member: "", outsider: "" };
const clients: Record<Key, SupabaseClient> = {} as Record<Key, SupabaseClient>;
let workspaceId = "";
let slug = "";
let otherSlug = "";
let otherWorkspaceId = "";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const emails = new Set<string>(Object.values(USERS));
  for (const u of data.users.filter((u) => emails.has(u.email ?? ""))) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C8.1 — actions connect/disconnect (autorisations réelles)", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();
    for (const key of Object.keys(USERS) as Key[]) {
      const { data, error } = await admin.auth.admin.createUser({
        email: USERS[key],
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: `C81a ${key}` },
      });
      if (error) throw error;
      ids[key] = data.user.id;
      const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, NO_SESSION);
      const { error: e2 } = await client.auth.signInWithPassword({ email: USERS[key], password: PASSWORD });
      if (e2) throw e2;
      clients[key] = client;
    }
    const { data: ws, error } = await clients.owner.rpc("create_workspace", { p_name: "C81a WS" });
    if (error) throw error;
    workspaceId = (ws as { id: string }).id;
    slug = (ws as { slug: string }).slug;
    await admin.from("workspace_members").insert({ workspace_id: workspaceId, user_id: ids.member, role: "member" });
    const { data: ws2, error: e3 } = await clients.outsider.rpc("create_workspace", { p_name: "C81a Autre" });
    if (e3) throw e3;
    otherSlug = (ws2 as { slug: string }).slug;
    otherWorkspaceId = (ws2 as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  it("connect — member refusé ; tiers : workspace indiscernable", async () => {
    currentActor = clients.member;
    const denied = await startConnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, platform: "youtube" }));
    expect(denied.error).toBe("Seul le propriétaire ou un admin du workspace peut gérer les comptes sociaux.");

    currentActor = clients.outsider;
    const foreign = await startConnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, platform: "youtube" }));
    expect(foreign.error).toBe("Workspace introuvable.");
  });

  it("connect — owner : plateforme invalide refusée ; provider non implémenté = message dédié (C8.1)", async () => {
    currentActor = clients.owner;
    const bad = await startConnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, platform: "myspace" }));
    expect(bad.error).toBe("Plateforme invalide.");
    const soon = await startConnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, platform: "youtube" }));
    expect(soon.error).toBe("L'intégration YouTube arrive dans une prochaine étape.");
  });

  it("disconnect — owner : ligne supprimée ET secrets Vault purgés ; member refusé ; id étranger introuvable", async () => {
    const accessId = await vaultStore(admin, "disc-access", "c81a/access");
    const refreshId = await vaultStore(admin, "disc-refresh", "c81a/refresh");
    const { data: row, error } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "youtube",
        provider_account_id: "UCdisc001",
        display_name: "À déconnecter",
        access_token_id: accessId,
        refresh_token_id: refreshId,
        connected_by: ids.owner,
      })
      .select("id")
      .single();
    expect(error).toBeNull();

    // member : refusé.
    currentActor = clients.member;
    const denied = await disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, accountId: row!.id }));
    expect(denied.error).toContain("propriétaire ou un admin");

    // outsider avec SON workspace mais l'id d'un compte du workspace A : introuvable.
    currentActor = clients.outsider;
    const cross = await disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: otherSlug, accountId: row!.id }));
    expect(cross.error).toBe("Compte introuvable.");
    const { count: still } = await admin
      .from("social_accounts").select("*", { count: "exact", head: true }).eq("id", row!.id);
    expect(still).toBe(1);

    // owner : succès, purge Vault via trigger.
    currentActor = clients.owner;
    const ok = await disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, accountId: row!.id }));
    expect(ok.error).toBeNull();
    const { count } = await admin
      .from("social_accounts").select("*", { count: "exact", head: true }).eq("id", row!.id);
    expect(count).toBe(0);
    expect(await vaultRead(admin, accessId)).toBeNull();
    expect(await vaultRead(admin, refreshId)).toBeNull();
  });

  /**
   * Purge des données de plateforme à la déconnexion.
   *
   * La première rédaction de la politique de confidentialité annonçait que
   * l'historique CONSERVAIT l'identifiant de chaîne et le lien des vidéos.
   * C'était exact au regard du code d'alors — et incompatible avec l'exigence
   * de suppression des données autorisées. Ces tests verrouillent le
   * comportement corrigé, des deux côtés : ce qui doit partir, et ce qui doit
   * rester.
   */
  /** Chaque test part d'un workspace vide : un échec ne doit pas en salir un autre. */
  async function repartirAZero() {
    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
    await admin.from("social_accounts").delete().eq("workspace_id", workspaceId);
  }

  async function compteAvecPublications(suffixe: string) {
    await repartirAZero();
    const accessId = await vaultStore(admin, `purge-access-${suffixe}`, `c81p/${suffixe}/access`);
    const refreshId = await vaultStore(admin, `purge-refresh-${suffixe}`, `c81p/${suffixe}/refresh`);
    const { data: compte } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "youtube",
        provider_account_id: "UC86PZJH-purge",
        display_name: "Chaîne à purger",
        avatar_url: "https://yt3.googleusercontent.com/avatar.jpg",
        access_token_id: accessId,
        refresh_token_id: refreshId,
        scopes: ["https://www.googleapis.com/auth/youtube.upload"],
        connected_by: ids.owner,
      })
      .select("id")
      .single();

    const commun = {
      workspace_id: workspaceId,
      social_account_id: compte!.id,
      platform: "youtube",
      provider_account_id: "UC86PZJH-purge",
      media_kind: "reel",
      media_url: "https://cdn.example.com/local.mp4",
      caption: "Légende écrite par l'utilisateur",
      requested_by: ids.owner,
    };
    const { data: lignes } = await admin
      .from("social_publications")
      .insert([
        {
          ...commun,
          status: "published",
          provider_media_id: "dQw4w9WgXcQ",
          permalink: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          container_id: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=SECRET",
          published_at: new Date().toISOString(),
        },
        {
          ...commun,
          status: "pending",
          container_id: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=ENCOURS",
        },
      ])
      .select("id, status");
    return { compteId: compte!.id, accessId, refreshId, lignes: lignes ?? [] };
  }

  it("PURGE : plus aucun identifiant, lien ni session YouTube après déconnexion", async () => {
    const { compteId, accessId, refreshId } = await compteAvecPublications("ok");

    currentActor = clients.owner;
    const ok = await disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, accountId: compteId }));
    expect(ok.error).toBeNull();

    // 1. Le compte et ses secrets ont disparu.
    const { count } = await admin
      .from("social_accounts").select("*", { count: "exact", head: true }).eq("id", compteId);
    expect(count).toBe(0);
    expect(await vaultRead(admin, accessId)).toBeNull();
    expect(await vaultRead(admin, refreshId)).toBeNull();

    // 2. Les publications ne portent PLUS rien qui vienne de la plateforme.
    const { data: pubs } = await admin
      .from("social_publications")
      .select("status, status_detail, provider_account_id, provider_media_id, permalink, container_id, purged_at, caption, media_url, platform, created_at")
      .eq("workspace_id", workspaceId)
      .eq("platform", "youtube");
    expect(pubs!.length).toBe(2);
    for (const p of pubs!) {
      expect(p.provider_account_id).toBeNull();
      expect(p.provider_media_id).toBeNull();
      expect(p.permalink).toBeNull();
      expect(p.container_id).toBeNull(); // l'URI de session part aussi
      expect(p.purged_at).not.toBeNull();

      // 3. Ce qui vient de l'utilisateur ou de nous est CONSERVÉ.
      expect(p.caption).toBe("Légende écrite par l'utilisateur");
      expect(p.media_url).toBe("https://cdn.example.com/local.mp4");
      expect(p.platform).toBe("youtube");
      expect(p.created_at).toBeTruthy();
    }

    // 4. Celle qui était en cours est ARRÊTÉE : plus jamais reprise.
    const enCours = pubs!.filter((p) => p.status === "pending");
    expect(enCours).toHaveLength(0);
    expect(pubs!.some((p) => p.status_detail === "account_disconnected")).toBe(true);
    // Et celle déjà publiée reste publiée : on n'efface pas le fait, seulement
    // les données de la plateforme.
    expect(pubs!.some((p) => p.status === "published")).toBe(true);

    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  });

  it("PURGE : elle a lieu même quand AUCUNE révocation distante n'aboutit", async () => {
    // C'est le cas qui compte le plus. Quand l'autorisation survit chez la
    // plateforme, il faut être d'autant plus certain de n'avoir rien gardé.
    //
    // Ce harnais le prouve à l'état pur : les providers ne s'enregistrent que
    // si leurs identifiants sont configurés, et ils ne le sont pas ici. Aucune
    // révocation n'est donc seulement tentée — et la purge locale doit malgré
    // tout être intégrale. Que `revoke` appelle bien le point d'accès de Google
    // est prouvé séparément, dans `youtube-provider.test.ts`.
    const { compteId, accessId } = await compteAvecPublications("revoke-ko");

    currentActor = clients.owner;
    const ok = await disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, accountId: compteId }));

    // La déconnexion locale aboutit quand même.
    expect(ok.error).toBeNull();
    const { count } = await admin
      .from("social_accounts").select("*", { count: "exact", head: true }).eq("id", compteId);
    expect(count).toBe(0);
    expect(await vaultRead(admin, accessId)).toBeNull();

    const { data: pubs } = await admin
      .from("social_publications")
      .select("provider_media_id, permalink, container_id, provider_account_id, purged_at")
      .eq("workspace_id", workspaceId);
    for (const p of pubs!) {
      expect(p.provider_media_id).toBeNull();
      expect(p.permalink).toBeNull();
      expect(p.container_id).toBeNull();
      expect(p.provider_account_id).toBeNull();
      expect(p.purged_at).not.toBeNull();
    }

    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  });

  it("PURGE : le planificateur ne reprend plus rien après une déconnexion", async () => {
    const { compteId } = await compteAvecPublications("scheduler");

    currentActor = clients.owner;
    await disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, accountId: compteId }));

    // Aucune ligne réclamable ne subsiste : ni `pending`, ni `scheduled`.
    const { data: reclamables } = await admin
      .from("social_publications")
      .select("id, status")
      .eq("workspace_id", workspaceId)
      .in("status", ["pending", "scheduled"]);
    expect(reclamables).toHaveLength(0);

    // Et rien ne pourrait de toute façon être repris : le conteneur a disparu
    // avec le jeton. Aucune session ne peut donc être poursuivie, ni doublée.
    const { data: pubs } = await admin
      .from("social_publications")
      .select("container_id, social_account_id")
      .eq("workspace_id", workspaceId);
    for (const p of pubs!) {
      expect(p.container_id).toBeNull();
      expect(p.social_account_id).toBeNull();
    }

    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  });

  // -------------------------------------------------------------------------
  // Sécurité de la RPC
  // -------------------------------------------------------------------------

  it("SÉCURITÉ : un client authenticated ne peut PAS appeler la RPC de purge", async () => {
    const { compteId } = await compteAvecPublications("securite");

    // `clients.owner` est le PROPRIÉTAIRE du workspace — le plus privilégié des
    // utilisateurs. S'il ne peut pas, personne ne peut : la seule voie est
    // l'action serveur, qui vérifie l'appartenance avant d'agir en service_role.
    const { error } = await clients.owner.rpc("disconnect_social_account", {
      p_account_id: compteId,
      p_workspace_id: workspaceId,
    });
    expect(error).not.toBeNull();
    // Droit refusé, ou fonction invisible depuis ce rôle : les deux conviennent.
    expect(`${error!.code} ${error!.message}`).toMatch(/42501|PGRST202|permission|not find/i);

    // Rien n'a bougé : le compte est intact.
    const { count } = await admin
      .from("social_accounts").select("*", { count: "exact", head: true }).eq("id", compteId);
    expect(count).toBe(1);

    await admin.from("social_accounts").delete().eq("id", compteId);
    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  });

  it("SÉCURITÉ : même en service_role, un workspace étranger ne purge rien", async () => {
    const { compteId } = await compteAvecPublications("cross");

    // Le bon compte, le MAUVAIS workspace. La fonction doit lever, et surtout
    // ne rien toucher — c'est la seconde barrière derrière l'action serveur.
    const { error } = await admin.rpc("disconnect_social_account", {
      p_account_id: compteId,
      p_workspace_id: otherWorkspaceId,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/introuvable dans ce workspace/);

    const { count } = await admin
      .from("social_accounts").select("*", { count: "exact", head: true }).eq("id", compteId);
    expect(count).toBe(1);
    const { data: intactes } = await admin
      .from("social_publications")
      .select("provider_media_id, permalink, purged_at")
      .eq("workspace_id", workspaceId);
    // AUCUNE ligne n'est purgée, et la publiée garde son permalien. La ligne
    // `pending`, elle, n'en a jamais eu : l'exiger d'elle aurait fait échouer
    // ce test pour une raison étrangère à l'isolation qu'il éprouve.
    expect(intactes!.every((p) => p.purged_at === null)).toBe(true);
    expect(intactes!.some((p) => p.permalink !== null)).toBe(true);

    // Arguments nuls : refus explicite, pas un silence.
    const { error: nul } = await admin.rpc("disconnect_social_account", {
      p_account_id: null,
      p_workspace_id: workspaceId,
    });
    expect(nul).not.toBeNull();

    await admin.from("social_accounts").delete().eq("id", compteId);
    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  });

  // -------------------------------------------------------------------------
  // Les écrans après la purge
  // -------------------------------------------------------------------------

  it("LECTURE : les trois écrans restent lisibles et ne fuient rien après purge", async () => {
    const { compteId } = await compteAvecPublications("vues");
    currentActor = clients.owner;
    await disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, accountId: compteId }));

    const mois = new Date().toISOString().slice(0, 7);
    const [recentes, calendrier, apercu] = await Promise.all([
      listRecentPublications(admin, workspaceId, 20),
      listPublicationsForMonth(admin, workspaceId, mois),
      listOverviewPublications(admin, workspaceId),
    ]);

    // 1. Aucun écran ne plante, et l'historique reste LISIBLE.
    for (const [nom, lignes] of [
      ["publications récentes", recentes],
      ["calendrier", calendrier],
      ["aperçu", apercu],
    ] as const) {
      expect(lignes.length, nom).toBeGreaterThanOrEqual(1);
      for (const p of lignes) {
        // 2. Plus rien de la plateforme.
        expect(p.provider_account_id, nom).toBeNull();
        expect(p.provider_media_id, nom).toBeNull();
        expect(p.permalink, nom).toBeNull();
        expect(p.container_id, nom).toBeNull();
        // 3. Ce qui rend l'historique compréhensible est TOUJOURS là.
        expect(p.caption, nom).toBe("Légende écrite par l'utilisateur");
        expect(p.platform, nom).toBe("youtube");
        expect(p.status, nom).toBeTruthy();
        expect(p.created_at, nom).toBeTruthy();
      }
    }

    // 4. La publication aboutie reste « publiée » : on n'efface pas le fait,
    //    seulement les données de la plateforme. L'absence de permalien est ce
    //    que les vues savent déjà rendre (ternaire sur `permalink`).
    const publiee = recentes.find((p) => p.status === "published");
    expect(publiee).toBeDefined();
    expect(publiee!.permalink).toBeNull();

    // 5. Aucun identifiant distant ne subsiste NULLE PART dans ce qui est rendu.
    const rendu = JSON.stringify([recentes, calendrier, apercu]);
    expect(rendu).not.toMatch(/dQw4w9WgXcQ/);
    expect(rendu).not.toMatch(/UC86PZJH/);
    expect(rendu).not.toMatch(/upload_id=/);

    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  });

  it("LECTURE : la purge des autres réseaux ne casse pas leurs vues non plus", async () => {
    await repartirAZero();
    // La purge est volontairement appliquée à TOUTE plateforme. Ce test le
    // constate pour TikTok, dont les identifiants ont une forme très différente.
    const accessId = await vaultStore(admin, "purge-tt", "c81p/tt/access");
    const { data: compte } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "tiktok",
        provider_account_id: "tiktok-open-id-xyz",
        display_name: "Compte TikTok",
        access_token_id: accessId,
        connected_by: ids.owner,
      })
      .select("id")
      .single();
    await admin.from("social_publications").insert({
      workspace_id: workspaceId,
      social_account_id: compte!.id,
      platform: "tiktok",
      provider_account_id: "tiktok-open-id-xyz",
      media_kind: "reel",
      media_url: "https://cdn.example.com/tt.mp4",
      caption: "Légende TikTok",
      status: "published",
      provider_media_id: "v_pub_url~v2-1.7680181457079781398",
      permalink: "https://www.tiktok.com/@ludo/video/7680181457079781398",
      published_at: new Date().toISOString(),
      requested_by: ids.owner,
    });

    currentActor = clients.owner;
    const ok = await disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, accountId: compte!.id }));
    expect(ok.error).toBeNull();

    const recentes = await listRecentPublications(admin, workspaceId, 20);
    expect(recentes.length).toBeGreaterThanOrEqual(1);
    for (const p of recentes) {
      expect(p.provider_media_id).toBeNull();
      expect(p.permalink).toBeNull();
      expect(p.caption).toBe("Légende TikTok");
    }
    // L'identifiant TikTok, qui est un int64 déguisé, ne subsiste pas non plus.
    expect(JSON.stringify(recentes)).not.toMatch(/7680181457079781398/);

    await admin.from("social_publications").delete().eq("workspace_id", workspaceId);
  });
});
