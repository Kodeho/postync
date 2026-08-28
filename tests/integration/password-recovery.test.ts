/**
 * C15 — Récupération de mot de passe : test RÉEL contre le projet Supabase de
 * `.env.local`.
 *
 * POURQUOI CETTE ÉTAPE EXISTE. Jusqu'ici, un client qui oubliait son mot de
 * passe était définitivement enfermé dehors : aucun lien « mot de passe
 * oublié », aucune route de récupération. Ses workspaces, ses comptes sociaux
 * connectés et ses publications programmées continuaient d'exister sans que
 * personne puisse y accéder — le planificateur publiant même en son nom.
 *
 * CE QUE CE FICHIER VÉRIFIE, dans l'ordre de ce qui peut mal tourner :
 *
 *   1. Le mécanisme fonctionne vraiment : un jeton de récupération ouvre une
 *      session, le mot de passe change, et le NOUVEAU permet de se connecter.
 *   2. L'ANCIEN mot de passe cesse de fonctionner. Sans cela, la
 *      réinitialisation n'aurait rien réinitialisé.
 *   3. Le jeton ne resservira pas : un lien de récupération est à usage
 *      unique, sinon il vaut mot de passe permanent dans une boîte mail.
 *   4. Les autres sessions sont révoquées. On réinitialise souvent parce
 *      qu'on soupçonne un accès indésirable ; laisser vivre les sessions déjà
 *      ouvertes annulerait tout le bénéfice de l'opération.
 * La non-divulgation (« la réponse est la même que le compte existe ou non »)
 * n'est PAS vérifiée ici : elle dépendrait du quota d'envoi Supabase et
 * échouerait au hasard. Elle l'est de façon déterministe dans
 * `tests/auth-reset-disclosure.test.ts`.
 *
 * Le jeton est obtenu par `generateLink` (API d'administration) plutôt que par
 * la boîte de réception : c'est le MÊME jeton que celui du courriel, ce qui
 * permet de rejouer le parcours réel sans dépendre d'un e-mail.
 *
 * Nettoyage complet en afterAll. Ignoré si `.env.local` est absent.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CONFIGURED = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);

const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };
const EMAIL = "postync-c15-recovery@example.com";
const ANCIEN = `C15-ancien-${randomUUID()}`;
const NOUVEAU = `C15-nouveau-${randomUUID()}`;

let admin: SupabaseClient;
let userId = "";

/** Client anonyme neuf : chaque session est isolée des autres. */
function session(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, NO_SESSION);
}

/** Jeton de récupération, identique à celui que porterait le courriel. */
async function jetonDeRecuperation(): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email: EMAIL,
  });
  if (error) throw error;
  const hash = data.properties?.hashed_token;
  if (!hash) throw new Error("aucun jeton renvoyé");
  return hash;
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((x) => x.email === EMAIL)) {
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) throw error;
  }
}

describe.skipIf(!CONFIGURED)("C15 — récupération de mot de passe (API réelle)", () => {
  beforeAll(async () => {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: ANCIEN,
      email_confirm: true,
      user_metadata: { display_name: "C15 Récupération" },
    });
    if (error) throw error;
    userId = data.user.id;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
    const { data } = await admin.from("profiles").select("id").eq("id", userId);
    expect(data ?? []).toHaveLength(0);
  }, 60_000);

  it("A1 — l'ancien mot de passe fonctionne avant toute réinitialisation", async () => {
    const { error } = await session().auth.signInWithPassword({
      email: EMAIL,
      password: ANCIEN,
    });
    expect(error).toBeNull();
  });

  // A2 — NON-DIVULGATION : volontairement absent d'ici.
  //
  // L'invariant « la réponse est la même que l'adresse existe ou non » est
  // vérifié de façon DÉTERMINISTE dans `tests/auth-reset-disclosure.test.ts`,
  // sur `shouldDiscloseResetError` — la règle qui décide de ce qui sort du
  // serveur, et qui est du ressort de POSTYNC.
  //
  // Le vérifier ici reviendrait à tester Supabase, et à le faire mal : deux
  // appels consécutifs à `resetPasswordForEmail` ne renvoient pas la même
  // chose selon que le quota d'envoi est déjà entamé ou non. Le test
  // échouait donc au gré du quota, sans qu'aucune régression n'ait eu lieu —
  // exactement le genre de test qui apprend à ignorer les échecs.

  it("A3 — le jeton ouvre une session, et le nouveau mot de passe la remplace", async () => {
    // Session « déjà ouverte ailleurs » : elle devra être révoquée à la fin.
    const autreSession = session();
    const { error: connexionAutre } = await autreSession.auth.signInWithPassword({
      email: EMAIL,
      password: ANCIEN,
    });
    expect(connexionAutre).toBeNull();

    // Parcours de récupération, avec le vrai jeton.
    const client = session();
    const { data, error } = await client.auth.verifyOtp({
      type: "recovery",
      token_hash: await jetonDeRecuperation(),
    });
    expect(error).toBeNull();
    expect(data.session).not.toBeNull();

    const { error: maj } = await client.auth.updateUser({ password: NOUVEAU });
    expect(maj).toBeNull();

    // Révocation des autres sessions, comme le fait la Server Action.
    const { error: revocation } = await client.auth.signOut({ scope: "others" });
    expect(revocation).toBeNull();

    // Le NOUVEAU mot de passe fonctionne…
    const nouvelle = await session().auth.signInWithPassword({
      email: EMAIL,
      password: NOUVEAU,
    });
    expect(nouvelle.error).toBeNull();

    // …et l'ANCIEN ne fonctionne plus. Sans cette ligne, le test passerait
    // même si la réinitialisation n'avait rien réinitialisé.
    const ancienne = await session().auth.signInWithPassword({
      email: EMAIL,
      password: ANCIEN,
    });
    expect(ancienne.error).not.toBeNull();
    expect(ancienne.data.session).toBeNull();

    // La session ouverte AVANT la réinitialisation ne peut plus se rafraîchir.
    const { error: refus } = await autreSession.auth.refreshSession();
    expect(refus).not.toBeNull();
  }, 60_000);

  it("A4 — un jeton de récupération ne sert qu'une fois", async () => {
    const jeton = await jetonDeRecuperation();

    const premier = await session().auth.verifyOtp({ type: "recovery", token_hash: jeton });
    expect(premier.error).toBeNull();

    // Un lien qui resservirait vaudrait mot de passe permanent, conservé en
    // clair dans une boîte de réception.
    const second = await session().auth.verifyOtp({ type: "recovery", token_hash: jeton });
    expect(second.error).not.toBeNull();
    expect(second.data.session).toBeNull();
  }, 60_000);

  it("A5 — un jeton fabriqué n'ouvre rien", async () => {
    const { data, error } = await session().auth.verifyOtp({
      type: "recovery",
      token_hash: randomUUID().replace(/-/g, ""),
    });
    expect(error).not.toBeNull();
    expect(data.session).toBeNull();
  }, 30_000);
});
