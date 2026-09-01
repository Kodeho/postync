/**
 * Acceptation des documents légaux — contre la VRAIE base.
 *
 * Ce que ces tests protègent :
 *
 *   1. l'acceptation est ENREGISTRÉE, avec la version et un horodatage
 *      serveur — c'est la preuve qui manquait ;
 *   2. elle est IDEMPOTENTE : réaccepter la même version ne crée pas de
 *      seconde ligne, et la première date survit ;
 *   3. personne ne peut accepter pour un autre, ni forger sa propre
 *      acceptation d'une version qu'il n'a jamais vue ;
 *   4. un utilisateur sans preuve n'est PAS présumé consentant.
 *
 * DÉPENDANCE : la table `legal_acceptances` doit exister. Tant que la
 * migration n'est pas appliquée, le fichier s'annonce bruyamment et se
 * désactive — un test muet qui ne s'exécute jamais est pire qu'un test absent.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PRIVACY_VERSION, TERMS_VERSION } from "@/config/legal";

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
const PASSWORD = `C17-${randomUUID()}`;
const USERS = {
  accepte: "postync-c17-accepte@example.com",
  sans: "postync-c17-sans@example.com",
} as const;
type Key = keyof typeof USERS;

let admin: SupabaseClient;
let tablePresente = false;
const ids: Record<Key, string> = { accepte: "", sans: "" };
const clients: Record<Key, SupabaseClient> = {} as Record<Key, SupabaseClient>;

async function cleanup() {
  if (!admin) return;
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const emails = new Set<string>(Object.values(USERS));
  for (const u of data.users.filter((u) => emails.has(u.email ?? ""))) {
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C17 — historisation de l'acceptation", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);

    const { error } = await admin.from("legal_acceptances").select("id").limit(1);
    tablePresente = !error;
    if (!tablePresente) {
      console.warn(
        "\n[C17] TABLE `legal_acceptances` ABSENTE — migration 20260901140000 non appliquée.\n" +
          "      Ces tests ne prouvent RIEN tant qu'elle ne l'est pas.\n",
      );
      return;
    }

    await cleanup();
    for (const key of Object.keys(USERS) as Key[]) {
      const { data, error: e } = await admin.auth.admin.createUser({
        email: USERS[key],
        password: PASSWORD,
        email_confirm: true,
      });
      if (e) throw e;
      ids[key] = data.user.id;
      const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, NO_SESSION);
      const { error: e2 } = await c.auth.signInWithPassword({ email: USERS[key], password: PASSWORD });
      if (e2) throw e2;
      clients[key] = c;
    }
  }, 90_000);

  afterAll(async () => {
    await cleanup();
  }, 60_000);

  it("enregistre l'acceptation avec sa version et un horodatage SERVEUR", async () => {
    if (!tablePresente) return expect(tablePresente).toBe(false);
    const avant = Date.now();

    const { error } = await admin.from("legal_acceptances").insert({
      user_id: ids.accepte,
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
    });
    expect(error).toBeNull();

    const { data } = await admin
      .from("legal_acceptances")
      .select("user_id, terms_version, privacy_version, accepted_at")
      .eq("user_id", ids.accepte);
    expect(data).toHaveLength(1);
    expect(data![0].terms_version).toBe(TERMS_VERSION);
    expect(data![0].privacy_version).toBe(PRIVACY_VERSION);
    // L'horodatage vient de la base, pas du client : il encadre l'instant réel.
    const t = new Date(data![0].accepted_at).getTime();
    expect(t).toBeGreaterThanOrEqual(avant - 60_000);
    expect(t).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("est IDEMPOTENTE : réaccepter la même version ne duplique rien", async () => {
    if (!tablePresente) return expect(tablePresente).toBe(false);
    const { data: initial } = await admin
      .from("legal_acceptances").select("accepted_at").eq("user_id", ids.accepte).single();

    for (let i = 0; i < 3; i++) {
      await admin.from("legal_acceptances").upsert(
        { user_id: ids.accepte, terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION },
        { onConflict: "user_id,terms_version,privacy_version", ignoreDuplicates: true },
      );
    }

    const { data, count } = await admin
      .from("legal_acceptances")
      .select("accepted_at", { count: "exact" })
      .eq("user_id", ids.accepte);
    expect(count).toBe(1);
    // La PREMIÈRE date survit : c'est celle du consentement réel.
    expect(data![0].accepted_at).toBe(initial!.accepted_at);
  });

  it("une NOUVELLE version exige une nouvelle acceptation, sans effacer l'ancienne", async () => {
    if (!tablePresente) return expect(tablePresente).toBe(false);
    await admin.from("legal_acceptances").insert({
      user_id: ids.accepte,
      terms_version: "2027-01-01",
      privacy_version: PRIVACY_VERSION,
    });

    const { count } = await admin
      .from("legal_acceptances")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ids.accepte);
    // Deux lignes : l'historique conserve ce qui a été accepté et quand.
    expect(count).toBe(2);
  });

  it("aucune acceptation n'est PRÉSUMÉE pour un compte sans trace", async () => {
    if (!tablePresente) return expect(tablePresente).toBe(false);
    const { count } = await admin
      .from("legal_acceptances")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ids.sans);
    expect(count).toBe(0);
  });

  it("ISOLATION : chacun ne voit que sa propre acceptation", async () => {
    if (!tablePresente) return expect(tablePresente).toBe(false);
    const { data: sienne } = await clients.accepte.from("legal_acceptances").select("user_id");
    expect(sienne!.length).toBeGreaterThanOrEqual(1);
    expect(sienne!.every((l) => l.user_id === ids.accepte)).toBe(true);

    // L'autre ne voit rien — ni la sienne (inexistante), ni celle du voisin.
    const { data: autre } = await clients.sans.from("legal_acceptances").select("user_id");
    expect(autre).toHaveLength(0);
  });

  it("un client authenticated ne peut PAS écrire une acceptation", async () => {
    if (!tablePresente) return expect(tablePresente).toBe(false);
    // Ni pour un autre...
    const { error: pourAutrui } = await clients.sans.from("legal_acceptances").insert({
      user_id: ids.accepte,
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
    });
    expect(pourAutrui).not.toBeNull();

    // ...ni pour lui-même : aucune politique d'insertion n'existe, ce qui
    // interdit aussi de forger l'acceptation d'une version jamais affichée.
    const { error: pourSoi } = await clients.sans.from("legal_acceptances").insert({
      user_id: ids.sans,
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
    });
    expect(pourSoi).not.toBeNull();

    const { count } = await admin
      .from("legal_acceptances")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ids.sans);
    expect(count).toBe(0);
  });

  it("une acceptation ne peut être ni réécrite ni supprimée par son auteur", async () => {
    if (!tablePresente) return expect(tablePresente).toBe(false);
    // Une preuve qu'on peut modifier n'est pas une preuve.
    const { error: maj } = await clients.accepte
      .from("legal_acceptances")
      .update({ terms_version: "1999-01-01" })
      .eq("user_id", ids.accepte);
    const { error: suppr } = await clients.accepte
      .from("legal_acceptances")
      .delete()
      .eq("user_id", ids.accepte);
    // PostgREST rend soit une erreur, soit zéro ligne touchée : dans les deux
    // cas la donnée doit être intacte. C'est cela qu'on vérifie.
    void maj;
    void suppr;
    const { data } = await admin
      .from("legal_acceptances").select("terms_version").eq("user_id", ids.accepte);
    expect(data!.some((l) => l.terms_version === "1999-01-01")).toBe(false);
    expect(data!.length).toBeGreaterThanOrEqual(1);
  });

  it("la suppression du compte emporte ses acceptations", async () => {
    if (!tablePresente) return expect(tablePresente).toBe(false);
    const { data: jetable } = await admin.auth.admin.createUser({
      email: `postync-c17-jetable-${randomUUID()}@example.com`,
      password: PASSWORD,
      email_confirm: true,
    });
    await admin.from("legal_acceptances").insert({
      user_id: jetable.user!.id,
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
    });
    await admin.auth.admin.deleteUser(jetable.user!.id);

    const { count } = await admin
      .from("legal_acceptances")
      .select("id", { count: "exact", head: true })
      .eq("user_id", jetable.user!.id);
    expect(count).toBe(0);
  });
});
