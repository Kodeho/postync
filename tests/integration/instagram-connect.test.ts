/**
 * C8.4a — chaîne de connexion Instagram de bout en bout contre la VRAIE base :
 * action serveur réelle, autorisations réelles, `oauth_states` réel.
 *
 * Ce fichier ne re-teste PAS ce que C8.1 couvre déjà génériquement (replay,
 * isolation, quota, Vault) : il vérifie ce qui est propre à Instagram —
 * l'enregistrement du provider, l'URL d'autorisation officielle réellement
 * produite, le state effectivement persisté HACHÉ, et la notice de
 * déconnexion imposée par l'absence de révocation côté Meta.
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
  for (const key of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]) {
    if (vars[key]) process.env[key] = vars[key];
  }
  // Identifiants Instagram FACTICES : le provider doit être enregistré, mais
  // aucun appel réseau n'est effectué par ce fichier (on s'arrête à l'URL).
  process.env.INSTAGRAM_APP_ID = "integration-ig-app-id";
  process.env.INSTAGRAM_APP_SECRET = "integration-ig-app-secret";
  process.env.NEXT_PUBLIC_SITE_URL = "https://postync.vercel.app";
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
import { hashState } from "@/server/social/pkce";
import { INSTAGRAM_REVOKE_NOTICE } from "@/server/social/providers/instagram";
import { getProvider } from "@/server/social/providers";
import { vaultRead, vaultStore } from "@/server/social/vault";

const CONFIGURED = Boolean(
  env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY,
);
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };
const PASSWORD = `C84a-${randomUUID()}`;
const EMAIL = "postync-c84a-owner@example.com";

let admin: SupabaseClient;
let ownerId = "";
let workspaceId = "";
let slug = "";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

/** Récupère l'URL d'un `redirect()` Next simulé par le harnais. */
async function captureRedirect(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("REDIRECT:")) return message.slice("REDIRECT:".length);
    throw error;
  }
  throw new Error("aucune redirection n'a eu lieu");
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((u) => u.email === EMAIL)) {
    await admin.from("workspaces").delete().eq("owner_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
}

describe.skipIf(!CONFIGURED)("C8.4a — connexion Instagram (chaîne réelle)", () => {
  beforeAll(async () => {
    admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
    await cleanup();

    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "C84a Owner" },
    });
    if (error) throw error;
    ownerId = data.user.id;

    const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, NO_SESSION);
    const { error: signInError } = await client.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (signInError) throw signInError;
    currentActor = client;

    const { data: ws, error: wsError } = await client.rpc("create_workspace", { p_name: "C84a Instagram WS" });
    if (wsError) throw wsError;
    workspaceId = (ws as { id: string }).id;
    slug = (ws as { slug: string }).slug;
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup();
    delete process.env.INSTAGRAM_APP_ID;
    delete process.env.INSTAGRAM_APP_SECRET;
  }, 60_000);

  it("le provider Instagram est enregistré dès que ses identifiants sont configurés", () => {
    const provider = getProvider("instagram");
    expect(provider).not.toBeNull();
    expect(provider?.platform).toBe("instagram");
    // Facebook reste volontairement non implémenté à cette sous-étape.
    expect(getProvider("facebook")).toBeNull();
  });

  it("connect — redirection vers l'URL d'autorisation officielle Instagram", async () => {
    const target = await captureRedirect(() =>
      startConnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, platform: "instagram" })),
    );
    const url = new URL(target);

    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("integration-ig-app-id");
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://postync.vercel.app/api/oauth/instagram/callback",
    );
    // Le secret ne doit jamais atteindre le navigateur.
    expect(target).not.toContain("integration-ig-app-secret");
  });

  it("le state part vers Instagram mais n'est stocké qu'en HACHÉ, non consommé, avec TTL", async () => {
    const target = await captureRedirect(() =>
      startConnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, platform: "instagram" })),
    );
    const state = new URL(target).searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(20);

    const { data: row } = await admin
      .from("oauth_states")
      .select("state_hash, platform, workspace_id, user_id, consumed_at, expires_at, code_verifier_id")
      .eq("state_hash", hashState(state))
      .maybeSingle();

    expect(row).not.toBeNull();
    expect(row!.platform).toBe("instagram");
    expect(row!.workspace_id).toBe(workspaceId);
    expect(row!.user_id).toBe(ownerId);
    expect(row!.consumed_at).toBeNull();
    expect(new Date(row!.expires_at).getTime()).toBeGreaterThan(Date.now());
    // Instagram n'utilise pas PKCE : aucun code_verifier ne doit être créé.
    expect(row!.code_verifier_id).toBeNull();

    // La valeur en clair ne doit se trouver nulle part en base.
    const { data: leak } = await admin
      .from("oauth_states")
      .select("id")
      .eq("state_hash", state);
    expect(leak ?? []).toHaveLength(0);
  });

  it("disconnect — la ligne et les secrets partent, et l'utilisateur est averti qu'Instagram ne révoque pas", async () => {
    const accessId = await vaultStore(admin, "ig-access-token", "c84a/access");
    const { data: row, error } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        provider_account_id: "17841400000000001",
        display_name: "postync.studio",
        access_token_id: accessId,
        // Instagram ne délivre pas de refresh token : la colonne reste nulle.
        refresh_token_id: null,
        connected_by: ownerId,
      })
      .select("id")
      .single();
    expect(error).toBeNull();

    // La déconnexion redirige vers la page avec le code de notice.
    const target = await captureRedirect(() =>
      disconnectAction(IDLE_SOCIAL_ACTION, form({ workspaceSlug: slug, accountId: row!.id })),
    );
    expect(target).toContain(`/app/${slug}/accounts`);
    expect(target).toContain("notice=manual_revoke");
    expect(target).toContain("platform=instagram");
    // Le texte affiché vient du provider, pas de la page.
    expect(getProvider("instagram")?.revokeNotice).toBe(INSTAGRAM_REVOKE_NOTICE);

    // Suppression réelle et purge Vault par le trigger C8.1.
    const { count } = await admin
      .from("social_accounts")
      .select("*", { count: "exact", head: true })
      .eq("id", row!.id);
    expect(count).toBe(0);
    expect(await vaultRead(admin, accessId)).toBeNull();
  });
});
