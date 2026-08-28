/**
 * Couche d'envoi de courriels — comportement RÉEL contre la base.
 *
 * Le transport est simulé : aucun courriel n'est expédié, aucune clé Scaleway
 * n'est nécessaire. Ce qui est vérifié ici n'est pas Scaleway, c'est ce que
 * POSTYNC garantit AUTOUR de Scaleway :
 *
 *   1. L'idempotence. Deux envois pour la même cause n'en produisent qu'un.
 *      C'est l'index unique de `email_deliveries` qui l'assure, pas la
 *      discipline de l'appelant — et une Server Action PEUT être rejouée.
 *   2. Le réessai. Passager → on réessaie. Définitif → jamais, sous peine de
 *      retarder l'erreur, de consommer le quota, et d'expédier deux fois un
 *      message qui était peut-être parti.
 *   3. Le journal. La ligne conserve de quoi diagnostiquer, mais AUCUN lien,
 *      donc aucun jeton d'invitation.
 *
 * Ignoré si `.env.local` est absent.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sendTransactionalEmail } from "@/server/email/send";
import type { TransportResult } from "@/server/email/scaleway";

function loadEnvLocal(): Record<string, string> {
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

const env = loadEnvLocal();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CONFIGURED = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

let admin: SupabaseClient;
const clesUtilisees: string[] = [];

/** Message minimal ; le contenu n'est pas le sujet de ce fichier. */
function requete(cle: string) {
  clesUtilisees.push(cle);
  return {
    idempotencyKey: cle,
    template: "test",
    to: { email: "postync-email-test@example.com" },
    subject: "Sujet de test",
    text: "Texte de test",
    html: "<p>Test</p>",
  };
}

/** Transport simulé : compte les appels et rend ce qu'on lui demande. */
function transportQuiRend(...resultats: TransportResult[]) {
  const appels: number[] = [];
  const fn = async (): Promise<TransportResult> => {
    const index = appels.length;
    appels.push(index);
    return resultats[Math.min(index, resultats.length - 1)];
  };
  return { fn, compte: () => appels.length };
}

const SUCCES: TransportResult = { ok: true, providerMessageId: "msg-simule" };

async function ligne(cle: string) {
  const { data } = await admin
    .from("email_deliveries")
    .select("id, status, attempts, failure_code, provider_message_id, template, recipient")
    .eq("idempotency_key", cle)
    .maybeSingle();
  return data;
}

describe.skipIf(!CONFIGURED)("couche d'envoi de courriels (base réelle)", () => {
  beforeAll(() => {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // La configuration est fournie par l'environnement du test : on vérifie la
    // MÉCANIQUE, pas les identifiants Scaleway, qui n'existent pas encore.
    process.env.SCW_SECRET_KEY = "cle-de-test";
    process.env.SCW_PROJECT_ID = "projet-de-test";
    process.env.EMAIL_FROM_ADDRESS = "no-reply@exemple.test";
  });

  afterEach(async () => {
    if (clesUtilisees.length > 0) {
      await admin.from("email_deliveries").delete().in("idempotency_key", clesUtilisees);
      clesUtilisees.length = 0;
    }
  });

  afterAll(async () => {
    delete process.env.SCW_SECRET_KEY;
    delete process.env.SCW_PROJECT_ID;
    delete process.env.EMAIL_FROM_ADDRESS;
    if (!admin) return;
    const { count } = await admin
      .from("email_deliveries")
      .select("id", { count: "exact", head: true })
      .eq("recipient", "postync-email-test@example.com");
    expect(count).toBe(0);
  });

  it("A1 — un envoi réussi laisse une trace exploitable, sans aucun lien", async () => {
    const cle = `test:${randomUUID()}`;
    const transport = transportQuiRend(SUCCES);

    const resultat = await sendTransactionalEmail(
      { db: admin, transport: transport.fn },
      requete(cle),
    );

    expect(resultat).toMatchObject({ ok: true, providerMessageId: "msg-simule" });
    const row = await ligne(cle);
    expect(row).toMatchObject({ status: "sent", attempts: 1, template: "test" });

    // Rien de ce qui est stocké ne doit ressembler à un lien : une invitation
    // porte un jeton, et POSTYNC n'en garde que l'empreinte. L'écrire dans un
    // journal annulerait ce soin.
    expect(JSON.stringify(row)).not.toContain("http");
  }, 30_000);

  it("A2 — la MÊME cause ne produit qu'un seul envoi", async () => {
    const cle = `test:${randomUUID()}`;
    const transport = transportQuiRend(SUCCES);

    const premier = await sendTransactionalEmail(
      { db: admin, transport: transport.fn },
      requete(cle),
    );
    const second = await sendTransactionalEmail(
      { db: admin, transport: transport.fn },
      requete(cle),
    );

    expect(premier.ok).toBe(true);
    expect(second).toEqual({ ok: false, code: "already_sent" });
    // Le point qui compte : le transport n'a été sollicité qu'une fois.
    expect(transport.compte()).toBe(1);
  }, 30_000);

  it("A3 — deux envois SIMULTANÉS de la même cause : un seul passe", async () => {
    const cle = `test:${randomUUID()}`;
    const transport = transportQuiRend(SUCCES);

    // La course réelle : double clic, ou reprise du navigateur. Vérifier
    // l'existence puis insérer laisserait la fenêtre habituelle entre les deux.
    const [a, b] = await Promise.all([
      sendTransactionalEmail({ db: admin, transport: transport.fn }, requete(cle)),
      sendTransactionalEmail({ db: admin, transport: transport.fn }, requete(cle)),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(transport.compte()).toBe(1);
  }, 30_000);

  it("A4 — un échec passager est réessayé, puis aboutit", async () => {
    const cle = `test:${randomUUID()}`;
    const transport = transportQuiRend(
      { ok: false, code: "provider_unavailable", status: 503 },
      SUCCES,
    );

    const resultat = await sendTransactionalEmail(
      { db: admin, transport: transport.fn, sleep: async () => {} },
      requete(cle),
    );

    expect(resultat.ok).toBe(true);
    expect(transport.compte()).toBe(2);
    expect(await ligne(cle)).toMatchObject({ status: "sent", attempts: 2 });
  }, 30_000);

  it("A5 — un échec DÉFINITIF n'est jamais réessayé", async () => {
    const cle = `test:${randomUUID()}`;
    const transport = transportQuiRend({ ok: false, code: "unauthorized", status: 401 });

    const resultat = await sendTransactionalEmail(
      { db: admin, transport: transport.fn, sleep: async () => {} },
      requete(cle),
    );

    expect(resultat).toEqual({ ok: false, code: "unauthorized" });
    // Une clé invalide le restera : insister retarderait le diagnostic.
    expect(transport.compte()).toBe(1);
    expect(await ligne(cle)).toMatchObject({ status: "failed", failure_code: "unauthorized" });
  }, 30_000);

  it("A6 — un passager qui persiste s'arrête, et le dit", async () => {
    const cle = `test:${randomUUID()}`;
    const transport = transportQuiRend({ ok: false, code: "timeout", status: null });

    const resultat = await sendTransactionalEmail(
      { db: admin, transport: transport.fn, sleep: async () => {} },
      requete(cle),
    );

    expect(resultat).toEqual({ ok: false, code: "timeout" });
    // Trois tentatives au total : au-delà, on fait attendre pour rien.
    expect(transport.compte()).toBe(3);
    expect(await ligne(cle)).toMatchObject({ status: "failed", failure_code: "timeout" });
  }, 30_000);

  it("A7 — sans configuration, rien n'est tenté ni journalisé", async () => {
    const sauvegarde = process.env.SCW_SECRET_KEY;
    delete process.env.SCW_SECRET_KEY;

    const cle = `test:${randomUUID()}`;
    const transport = transportQuiRend(SUCCES);
    const resultat = await sendTransactionalEmail(
      { db: admin, transport: transport.fn },
      requete(cle),
    );

    // État NORMAL tant que le domaine n'est pas authentifié : l'appelant se
    // rabat sur le lien à copier plutôt que de laisser croire à un envoi.
    expect(resultat).toEqual({ ok: false, code: "not_configured" });
    expect(transport.compte()).toBe(0);
    expect(await ligne(cle)).toBeNull();

    process.env.SCW_SECRET_KEY = sauvegarde;
  }, 30_000);

  it("A8 — la table reste inaccessible à toute session", async () => {
    // Même protection qu'`oauth_states` : ce journal dit qui reçoit quoi,
    // et quand.
    const anon = createClient(SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await anon.from("email_deliveries").select("id").limit(1);
    expect(error).not.toBeNull();
  }, 30_000);
});
