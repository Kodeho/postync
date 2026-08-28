/**
 * E2E C14 — cote invite.
 *
 * Cree (ou reutilise) le compte invite, puis accepte l'invitation avec SA
 * session, exactement comme le ferait la Server Action. Le mot de passe est
 * genere ici et n'est jamais saisi dans un formulaire de navigateur.
 *
 * Usage :
 *   node e2e-invitee.mjs create
 *   node e2e-invitee.mjs accept <token>
 *   node e2e-invitee.mjs cleanup
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const i = line.indexOf("=");
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } };

const EMAIL = "postync-c14-e2e@example.com";
const PW_FILE = process.argv[3 + 1] ?? ".e2e-c14-pw";

const admin = createClient(URL, SERVICE, NO_SESSION);
const [, , command, arg] = process.argv;

function password() {
  if (existsSync(PW_FILE)) return readFileSync(PW_FILE, "utf8").trim();
  const pw = `E2E-${crypto.randomUUID()}`;
  writeFileSync(PW_FILE, pw);
  return pw;
}

async function findUser() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  return data.users.find((u) => u.email === EMAIL) ?? null;
}

if (command === "create") {
  const existing = await findUser();
  if (existing) {
    console.log(JSON.stringify({ status: "already_exists", id: existing.id, email: EMAIL }));
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: password(),
      email_confirm: true,
      user_metadata: { display_name: "Invite E2E C14" },
    });
    if (error) throw error;
    console.log(JSON.stringify({ status: "created", id: data.user.id, email: EMAIL }));
  }
} else if (command === "accept") {
  const client = createClient(URL, ANON, NO_SESSION);
  const { error: signIn } = await client.auth.signInWithPassword({
    email: EMAIL,
    password: password(),
  });
  if (signIn) throw signIn;

  const hash = createHash("sha256").update(arg).digest("hex");
  const { data, error } = await client.rpc("accept_workspace_invitation", {
    p_token_hash: hash,
  });
  if (error) throw error;
  console.log(JSON.stringify(data));
} else if (command === "cleanup") {
  const user = await findUser();
  if (!user) {
    console.log(JSON.stringify({ status: "absent" }));
  } else {
    await admin.from("workspace_members").delete().eq("user_id", user.id);
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw error;
    console.log(JSON.stringify({ status: "deleted" }));
  }
} else {
  console.error("commande inconnue");
  process.exit(1);
}
