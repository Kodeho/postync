/**
 * C9 — médiathèque contre la VRAIE base et le VRAI bucket Supabase.
 *
 * Ce qu'on éprouve ici est le cœur de sécurité du stockage : le bucket est
 * fermé, l'isolation par workspace est structurelle, le quota du plan borne
 * les téléversements, et une URL signée n'est jamais enregistrée.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deleteAsset,
  finalizeUpload,
  requestUpload,
  signMediaUrl,
  workspaceStorageBytes,
  type MediaDeps,
} from "@/server/media/library";

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
const PASSWORD = `C9-${randomUUID()}`;
const USERS = {
  owner: "postync-c9-owner@example.com",
  outsider: "postync-c9-outsider@example.com",
} as const;
type Key = keyof typeof USERS;

/** Petit MP4 factice : le contenu importe peu, la taille et le chemin oui. */
const OCTETS = new Uint8Array(2048).fill(7);

let admin: SupabaseClient;
const ids: Record<Key, string> = { owner: "", outsider: "" };
const clients: Record<Key, SupabaseClient> = {} as Record<Key, SupabaseClient>;
let workspaceId = "";
let otherWorkspaceId = "";

function deps(quotaGb = 5): MediaDeps {
  return { db: admin, getStorageQuotaGb: async () => quotaGb };
}

/** Téléverse réellement les octets à l'URL signée délivrée par le serveur. */
async function televerser(uploadUrl: string, mimeType: string): Promise<number> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": mimeType },
    body: OCTETS,
  });
  return response.status;
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const emails = new Set<string>(Object.values(USERS));
  for (const u of data.users.filter((u) => emails.has(u.email ?? ""))) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C9 — médiathèque (bucket et base réels)", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    for (const key of Object.keys(USERS) as Key[]) {
      const { data, error } = await admin.auth.admin.createUser({
        email: USERS[key],
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: `C9 ${key}` },
      });
      if (error) throw error;
      ids[key] = data.user.id;
      const client = createClient(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        NO_SESSION,
      );
      const { error: e } = await client.auth.signInWithPassword({
        email: USERS[key],
        password: PASSWORD,
      });
      if (e) throw e;
      clients[key] = client;
    }

    const { data: ws, error } = await clients.owner.rpc("create_workspace", { p_name: "C9 WS" });
    if (error) throw error;
    workspaceId = (ws as { id: string }).id;

    const { data: ws2, error: e2 } = await clients.outsider.rpc("create_workspace", {
      p_name: "C9 Autre",
    });
    if (e2) throw e2;
    otherWorkspaceId = (ws2 as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Le bucket est fermé
  // -------------------------------------------------------------------------

  it("le bucket est privé et inaccessible à un utilisateur connecté", async () => {
    const { data: bucket } = await admin.storage.getBucket("media");
    expect(bucket?.public).toBe(false);
    // Le SDK expose le plafond en snake_case selon les versions : on lit la
    // valeur quelle que soit sa forme plutot que de figer un nom de champ.
    const brut = bucket as unknown as Record<string, unknown>;
    const plafond = brut.file_size_limit ?? brut.fileSizeLimit;
    expect(Number(plafond)).toBe(314_572_800);
    const types = (brut.allowed_mime_types ?? brut.allowedMimeTypes) as string[] | null;
    expect(types).toContain("video/mp4");
    expect(types).not.toContain("image/png");

    // Un utilisateur légitime ne peut ni lister, ni téléverser directement :
    // aucune politique n'ouvre `storage.objects` sur ce bucket.
    const liste = await clients.owner.storage.from("media").list(workspaceId);
    expect((liste.data ?? []).length).toBe(0);

    const depot = await clients.owner.storage
      .from("media")
      .upload(`${workspaceId}/intrus.mp4`, OCTETS, { contentType: "video/mp4" });
    expect(depot.error).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Téléversement
  // -------------------------------------------------------------------------

  it("parcours complet : URL signée, octets déposés, média prêt", async () => {
    const demande = await requestUpload(deps(), {
      workspaceId,
      userId: ids.owner,
      filename: "ma video.mp4",
      mimeType: "video/mp4",
      byteSize: OCTETS.length,
    });
    expect(demande.ok).toBe(true);
    if (!demande.ok) return;

    // Le chemin est construit par le serveur : workspace en tête, nom en UUID.
    expect(demande.storagePath.startsWith(`${workspaceId}/`)).toBe(true);
    expect(demande.storagePath).not.toContain("ma video");

    expect(await televerser(demande.uploadUrl, "video/mp4")).toBe(200);

    // Tant que rien n'est confirmé, le média n'est pas publiable.
    const { data: avant } = await admin
      .from("media_assets")
      .select("status, original_filename")
      .eq("id", demande.assetId)
      .single();
    expect(avant!.status).toBe("uploading");
    expect(avant!.original_filename).toBe("ma video.mp4");

    const finalise = await finalizeUpload(admin, {
      workspaceId,
      assetId: demande.assetId,
      probe: { width: 720, height: 1280, durationSeconds: 30, videoCodec: "avc1", fastStart: true },
    });
    expect(finalise.ok).toBe(true);
    if (!finalise.ok) return;
    expect(finalise.asset.status).toBe("ready");
    expect(finalise.asset.duration_seconds).toBe(30);
    expect(finalise.asset.width).toBe(720);

    await deleteAsset(admin, { workspaceId, assetId: demande.assetId });
  });

  it("fichier annoncé mais jamais déposé : refusé et marqué invalide", async () => {
    const demande = await requestUpload(deps(), {
      workspaceId,
      userId: ids.owner,
      filename: "fantome.mp4",
      mimeType: "video/mp4",
      byteSize: 1024,
    });
    if (!demande.ok) throw new Error("demande refusée");

    // On ne téléverse rien : la ligne ne doit pas pouvoir passer « prête ».
    const finalise = await finalizeUpload(admin, {
      workspaceId,
      assetId: demande.assetId,
      probe: { width: 720, height: 1280, durationSeconds: 10, videoCodec: "avc1", fastStart: true },
    });
    expect(finalise).toMatchObject({ ok: false, code: "storage_failed" });

    const { data: row } = await admin
      .from("media_assets")
      .select("status, status_detail")
      .eq("id", demande.assetId)
      .single();
    expect(row!.status).toBe("invalid");
    expect(row!.status_detail).toBe("fichier_absent");

    await admin.from("media_assets").delete().eq("id", demande.assetId);
  });

  it("type refusé et taille excessive : rejetés avant toute écriture", async () => {
    const mauvaisType = await requestUpload(deps(), {
      workspaceId,
      userId: ids.owner,
      filename: "script.exe",
      mimeType: "application/x-msdownload",
      byteSize: 1024,
    });
    expect(mauvaisType).toEqual({ ok: false, code: "mime_not_supported" });

    const tropGros = await requestUpload(deps(), {
      workspaceId,
      userId: ids.owner,
      filename: "enorme.mp4",
      mimeType: "video/mp4",
      byteSize: 400 * 1024 * 1024,
    });
    expect(tropGros).toEqual({ ok: false, code: "too_large" });

    const { count } = await admin
      .from("media_assets")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    expect(count).toBe(0);
  });

  it("quota du plan : dépassement refusé avant de délivrer une URL d'upload", async () => {
    // Quota d'un octet : rien ne peut passer.
    const refuse = await requestUpload({ db: admin, getStorageQuotaGb: async () => 0 }, {
      workspaceId,
      userId: ids.owner,
      filename: "trop.mp4",
      mimeType: "video/mp4",
      byteSize: 1024,
    });
    expect(refuse).toEqual({ ok: false, code: "quota_exceeded" });
  });

  it("la consommation ne compte que les médias non invalides", async () => {
    const a = await requestUpload(deps(), {
      workspaceId,
      userId: ids.owner,
      filename: "a.mp4",
      mimeType: "video/mp4",
      byteSize: 1000,
    });
    const b = await requestUpload(deps(), {
      workspaceId,
      userId: ids.owner,
      filename: "b.mp4",
      mimeType: "video/mp4",
      byteSize: 500,
    });
    if (!a.ok || !b.ok) throw new Error("demande refusée");

    expect(await workspaceStorageBytes(admin, workspaceId)).toBe(1500);
    await admin.from("media_assets").update({ status: "invalid" }).eq("id", b.assetId);
    expect(await workspaceStorageBytes(admin, workspaceId)).toBe(1000);

    await admin.from("media_assets").delete().eq("workspace_id", workspaceId);
  });

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  it("isolation — un média d'un autre workspace est introuvable", async () => {
    const demande = await requestUpload(deps(), {
      workspaceId,
      userId: ids.owner,
      filename: "prive.mp4",
      mimeType: "video/mp4",
      byteSize: OCTETS.length,
    });
    if (!demande.ok) throw new Error("demande refusée");
    await televerser(demande.uploadUrl, "video/mp4");
    await finalizeUpload(admin, {
      workspaceId,
      assetId: demande.assetId,
      probe: { width: 720, height: 1280, durationSeconds: 30, videoCodec: "avc1", fastStart: true },
    });

    // Identifiant réel, mais workspace qui n'est pas le sien.
    expect(
      await signMediaUrl(admin, { workspaceId: otherWorkspaceId, assetId: demande.assetId }),
    ).toEqual({ ok: false, code: "asset_not_found" });
    expect(
      await deleteAsset(admin, { workspaceId: otherWorkspaceId, assetId: demande.assetId }),
    ).toEqual({ ok: false, code: "asset_not_found" });

    // RLS : un tiers ne voit rien de la médiathèque.
    const { data: vuTiers } = await clients.outsider
      .from("media_assets")
      .select("id")
      .eq("workspace_id", workspaceId);
    expect(vuTiers ?? []).toHaveLength(0);

    // Le membre légitime voit son média, mais ne peut rien écrire.
    const { data: vuOwner } = await clients.owner
      .from("media_assets")
      .select("id, storage_path, status")
      .eq("workspace_id", workspaceId);
    expect((vuOwner ?? []).length).toBe(1);

    const ecriture = await clients.owner
      .from("media_assets")
      .update({ status: "ready" })
      .eq("id", demande.assetId);
    expect(ecriture.error).not.toBeNull();

    await deleteAsset(admin, { workspaceId, assetId: demande.assetId });
  });

  // -------------------------------------------------------------------------
  // URL signée et suppression
  // -------------------------------------------------------------------------

  it("URL signée : fonctionnelle, jamais enregistrée, refusée si non prêt", async () => {
    const demande = await requestUpload(deps(), {
      workspaceId,
      userId: ids.owner,
      filename: "signe.mp4",
      mimeType: "video/mp4",
      byteSize: OCTETS.length,
    });
    if (!demande.ok) throw new Error("demande refusée");
    await televerser(demande.uploadUrl, "video/mp4");

    // Un média pas encore confirmé n'est pas signable.
    expect(await signMediaUrl(admin, { workspaceId, assetId: demande.assetId })).toEqual({
      ok: false,
      code: "not_ready",
    });

    await finalizeUpload(admin, {
      workspaceId,
      assetId: demande.assetId,
      probe: { width: 720, height: 1280, durationSeconds: 30, videoCodec: "avc1", fastStart: true },
    });

    const signe = await signMediaUrl(admin, { workspaceId, assetId: demande.assetId });
    expect(signe.ok).toBe(true);
    if (!signe.ok) return;
    expect(signe.url).toContain("/object/sign/media/");
    expect(signe.url).toContain("token=");

    // L'URL fonctionne réellement, et sert bien les octets déposés.
    const recuperation = await fetch(signe.url);
    expect(recuperation.status).toBe(200);
    expect((await recuperation.arrayBuffer()).byteLength).toBe(OCTETS.length);

    // Et surtout : elle n'est nulle part en base.
    const { data: ligne } = await admin
      .from("media_assets")
      .select("*")
      .eq("id", demande.assetId)
      .single();
    expect(JSON.stringify(ligne)).not.toContain("token=");
    expect(JSON.stringify(ligne)).not.toContain("/object/sign/");

    await deleteAsset(admin, { workspaceId, assetId: demande.assetId });
  });

  it("suppression : l'objet part du bucket, puis la ligne", async () => {
    const demande = await requestUpload(deps(), {
      workspaceId,
      userId: ids.owner,
      filename: "asupprimer.mp4",
      mimeType: "video/mp4",
      byteSize: OCTETS.length,
    });
    if (!demande.ok) throw new Error("demande refusée");
    await televerser(demande.uploadUrl, "video/mp4");
    await finalizeUpload(admin, {
      workspaceId,
      assetId: demande.assetId,
      probe: { width: 720, height: 1280, durationSeconds: 30, videoCodec: "avc1", fastStart: true },
    });

    expect(await deleteAsset(admin, { workspaceId, assetId: demande.assetId })).toEqual({
      ok: true,
    });

    const { count } = await admin
      .from("media_assets")
      .select("*", { count: "exact", head: true })
      .eq("id", demande.assetId);
    expect(count).toBe(0);

    // L'objet a réellement disparu du bucket : c'est la seule révocation
    // d'accès qui vaille, l'expiration d'un jeton ne suffit pas.
    const { data: reste } = await admin.storage
      .from("media")
      .list(workspaceId, { search: demande.storagePath.split("/")[1] });
    expect(reste ?? []).toHaveLength(0);
  });

  it("cascade — supprimer le workspace emporte les lignes de la médiathèque", async () => {
    const { data: ws } = await clients.owner.rpc("create_workspace", { p_name: "C9 Jetable" });
    const jetable = (ws as { id: string }).id;
    const demande = await requestUpload(deps(), {
      workspaceId: jetable,
      userId: ids.owner,
      filename: "jetable.mp4",
      mimeType: "video/mp4",
      byteSize: 1024,
    });
    if (!demande.ok) throw new Error("demande refusée");

    await admin.from("workspaces").delete().eq("id", jetable);
    const { count } = await admin
      .from("media_assets")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", jetable);
    expect(count).toBe(0);
  });
});
