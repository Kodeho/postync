/**
 * Formulaire /signup — conservation des champs après une erreur.
 *
 * Exigences vérifiées :
 *   - le nom est conservé après une erreur ;
 *   - l'e-mail est conservé après une erreur ;
 *   - le mot de passe n'est ni conservé, ni renvoyé, ni réinjecté ;
 *   - la confirmation du mot de passe non plus.
 *
 * Deux niveaux sont couverts : l'état renvoyé par la Server Action (ce qui
 * transite réellement vers le navigateur) et le rendu HTML des champs.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SignupFields } from "@/features/auth/signup-fields";
import type { AuthFormState } from "@/features/auth/state";
import { extractSignupPreservedValues } from "@/features/auth/validation";

const SECRET = "S3cret-Pa55word!";
const SECRET_CONFIRM = "Autre-Pa55word!";

function buildForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("displayName", "Ludovic Test");
  form.set("email", "Ludovic.Test@Example.com");
  form.set("password", SECRET);
  form.set("confirmPassword", SECRET_CONFIRM);
  for (const [key, value] of Object.entries(overrides)) {
    form.set(key, value);
  }
  return form;
}

/** Garantit qu'aucun secret ne figure nulle part dans l'état renvoyé. */
function expectNoPasswordLeak(state: AuthFormState) {
  const serialized = JSON.stringify(state);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain(SECRET_CONFIRM);
  expect(serialized).not.toMatch(/password/i);
  expect(state.values).not.toHaveProperty("password");
  expect(state.values).not.toHaveProperty("confirmPassword");
}

// ---------------------------------------------------------------------------
// Extraction des valeurs préservées
// ---------------------------------------------------------------------------
describe("extractSignupPreservedValues", () => {
  it("ne retient que le nom et l'e-mail", () => {
    const values = extractSignupPreservedValues(buildForm());

    expect(values).toEqual({
      displayName: "Ludovic Test",
      email: "ludovic.test@example.com",
    });
    expect(Object.keys(values)).toEqual(["displayName", "email"]);
  });
});

// ---------------------------------------------------------------------------
// État renvoyé par la Server Action
// ---------------------------------------------------------------------------
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/site-url", () => ({
  getSiteOrigin: vi.fn(async () => "http://localhost:3000"),
}));

const signUpMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { signUp: signUpMock } })),
}));

describe("signUpAction — état après erreur", () => {
  let signUpAction: typeof import("@/features/auth/actions").signUpAction;
  let EMPTY_AUTH_STATE: typeof import("@/features/auth/state").EMPTY_AUTH_STATE;

  beforeAll(async () => {
    // `env.ts` lit les variables au chargement du module : elles doivent être
    // définies AVANT l'import dynamique pour passer le garde-fou de config.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-de-test";

    ({ signUpAction } = await import("@/features/auth/actions"));
    ({ EMPTY_AUTH_STATE } = await import("@/features/auth/state"));
  });

  it("conserve le nom et l'e-mail après une erreur de validation", async () => {
    const state = await signUpAction(EMPTY_AUTH_STATE, buildForm());

    expect(state.error).toBe("Les deux mots de passe ne sont pas identiques.");
    expect(state.values?.displayName).toBe("Ludovic Test");
    expect(state.values?.email).toBe("ludovic.test@example.com");
  });

  it("ne renvoie jamais le mot de passe ni sa confirmation", async () => {
    const state = await signUpAction(EMPTY_AUTH_STATE, buildForm());

    expectNoPasswordLeak(state);
  });

  it("conserve nom et e-mail même si l'erreur vient du mot de passe", async () => {
    const state = await signUpAction(
      EMPTY_AUTH_STATE,
      buildForm({ password: "court", confirmPassword: "court" }),
    );

    expect(state.error).toMatch(/au moins 8 caractères/);
    expect(state.values).toEqual({
      displayName: "Ludovic Test",
      email: "ludovic.test@example.com",
    });
    expect(JSON.stringify(state)).not.toContain("court");
  });

  it("conserve nom et e-mail sur une erreur renvoyée par Supabase", async () => {
    signUpMock.mockResolvedValueOnce({
      data: { user: { identities: [] }, session: null },
      error: null,
    });

    const state = await signUpAction(
      EMPTY_AUTH_STATE,
      buildForm({ confirmPassword: SECRET }),
    );

    expect(state.error).toBe("Cette adresse e-mail est déjà utilisée.");
    expect(state.values).toEqual({
      displayName: "Ludovic Test",
      email: "ludovic.test@example.com",
    });
    expectNoPasswordLeak(state);
  });

  it("ne renvoie aucune valeur quand l'inscription réussit", async () => {
    signUpMock.mockResolvedValueOnce({
      data: { user: { identities: [{ id: "x" }] }, session: null },
      error: null,
    });

    const state = await signUpAction(
      EMPTY_AUTH_STATE,
      buildForm({ confirmPassword: SECRET }),
    );

    expect(state.error).toBeNull();
    expect(state.notice).toMatch(/Compte créé/);
    expect(state.values).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rendu HTML des champs
// ---------------------------------------------------------------------------
describe("SignupFields — rendu après erreur", () => {
  const html = renderToStaticMarkup(
    <SignupFields
      values={{ displayName: "Ludovic Test", email: "ludovic.test@example.com" }}
    />,
  );

  function inputTag(name: string): string {
    const match = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`));
    expect(match, `champ ${name} absent du rendu`).not.toBeNull();
    return match![0];
  }

  it("réinjecte le nom", () => {
    expect(inputTag("displayName")).toContain('value="Ludovic Test"');
  });

  it("réinjecte l'e-mail", () => {
    expect(inputTag("email")).toContain('value="ludovic.test@example.com"');
  });

  it("laisse le mot de passe vide", () => {
    const tag = inputTag("password");
    expect(tag).toContain('type="password"');
    expect(tag).not.toMatch(/\svalue=/);
  });

  it("laisse la confirmation du mot de passe vide", () => {
    const tag = inputTag("confirmPassword");
    expect(tag).toContain('type="password"');
    expect(tag).not.toMatch(/\svalue=/);
  });

  it("reste vide de toute valeur sans état serveur", () => {
    const initial = renderToStaticMarkup(<SignupFields />);
    expect(initial).not.toMatch(/\svalue=/);
  });
});
