/**
 * Journal des passes de rétention — les deux invariants, prouvés.
 *
 * 1. `consignerPasse` ne lève JAMAIS : ni sur `{ error }` rendu, ni sur une
 *    exception levée par le client. Une passe réussie dont la journalisation
 *    échoue reste une passe réussie.
 * 2. `codeErreurControle` ne rend que des codes du vocabulaire fermé, et le
 *    message d'origine — sensible ou non — n'apparaît jamais dans le code.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODES_ERREUR,
  codeErreurControle,
  consignerPasse,
  type LignePasse,
} from "@/server/social/retention-journal";

const LIGNE: LignePasse = {
  examined: 1,
  refreshed: 1,
  purged: 0,
  retried: 0,
  publications_purged: 0,
  batches: 1,
  saturated: false,
  duration_ms: 42,
  error_code: null,
};

/** Client minimal dont on choisit le comportement d'insert. */
function dbAvecInsert(insert: () => Promise<{ error: unknown }>) {
  return { from: () => ({ insert }) } as never;
}

describe("consignerPasse — le journal ne casse jamais la passe", () => {
  it("aboutit quand l'insert réussit", async () => {
    await expect(
      consignerPasse(dbAvecInsert(async () => ({ error: null })), LIGNE),
    ).resolves.toBeUndefined();
  });

  it("avale une erreur RENDUE ({ error }) sans la propager", async () => {
    await expect(
      consignerPasse(dbAvecInsert(async () => ({ error: { code: "42P01" } })), LIGNE),
    ).resolves.toBeUndefined();
  });

  it("avale une exception LEVÉE par l'insert (rejet réseau)", async () => {
    await expect(
      consignerPasse(
        dbAvecInsert(async () => {
          throw new TypeError("fetch failed");
        }),
        LIGNE,
      ),
    ).resolves.toBeUndefined();
  });

  it("avale une exception SYNCHRONE (client mal construit : from() lève)", async () => {
    const db = {
      from: () => {
        throw new Error("client hors service");
      },
    } as never;
    await expect(consignerPasse(db, LIGNE)).resolves.toBeUndefined();
  });
});

describe("codeErreurControle — vocabulaire fermé, message jamais recopié", () => {
  it("classe les libellés internes connus", () => {
    expect(codeErreurControle(new Error("vault read: 42501"))).toBe("vault_error");
    expect(codeErreurControle(new Error("vault store: aucun id"))).toBe("vault_error");
    expect(codeErreurControle(new Error("refresh persist: 23505"))).toBe("db_error");
    expect(codeErreurControle(new Error("google refresh: HTTP 500 backendError"))).toBe(
      "provider_error",
    );
    expect(codeErreurControle(new Error("youtube channels: HTTP 403 quotaExceeded"))).toBe(
      "provider_error",
    );
    expect(codeErreurControle(new TypeError("fetch failed"))).toBe("network_error");
  });

  it("rabat tout le reste sur unknown_error, sans reprendre le message", () => {
    const sensible = new Error("Authorization: Bearer ya29.EXEMPLE-DE-JETON http://signe?sig=x");
    const code = codeErreurControle(sensible);
    expect(code).toBe("unknown_error");
    expect(code).not.toContain("Bearer");
    expect(code).not.toContain("ya29");
  });

  it("accepte les non-Error et ne rend QUE des codes du vocabulaire", () => {
    const candidats: unknown[] = [
      undefined,
      null,
      "chaîne brute",
      42,
      new Error(""),
      new Error("message quelconque avec des détails"),
      new Error("vault read: x"),
      new TypeError("network down"),
    ];
    for (const c of candidats) {
      expect(CODES_ERREUR).toContain(codeErreurControle(c));
    }
  });
});

describe("aucune sortie ne laisse passer un secret", () => {
  const SECRET = "ya29.FAUX-SECRET-a1b2c3d4e5f6";

  /** Toutes les écritures console de l'appel, à plat. */
  function capterConsole() {
    return {
      erreur: vi.spyOn(console, "error").mockImplementation(() => {}),
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
    };
  }
  function toutesLesSorties(spies: ReturnType<typeof capterConsole>): string {
    return [...spies.erreur.mock.calls, ...spies.log.mock.calls, ...spies.info.mock.calls]
      .flat()
      .map(String)
      .join("\n");
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exception LEVÉE portant un secret : rien ne sort, code contrôlé loggé", async () => {
    const spies = capterConsole();
    await consignerPasse(
      dbAvecInsert(async () => {
        throw new Error(`Authorization: Bearer ${SECRET}`);
      }),
      LIGNE,
    );
    const sorties = toutesLesSorties(spies);
    expect(sorties).not.toContain(SECRET);
    expect(sorties).not.toContain("Bearer");
    expect(sorties).toContain("unknown_error");
  });

  it("erreur RENDUE dont le message porte un secret : seul le champ code sort", async () => {
    const spies = capterConsole();
    await consignerPasse(
      dbAvecInsert(async () => ({
        error: { code: "PGRST301", message: `jwt: ${SECRET}` },
      })),
      LIGNE,
    );
    const sorties = toutesLesSorties(spies);
    expect(sorties).not.toContain(SECRET);
    expect(sorties).toContain("db_error/PGRST301");
  });

  it("champ code qui n'a PAS la forme d'un code : remplacé, jamais recopié", async () => {
    const spies = capterConsole();
    await consignerPasse(
      dbAvecInsert(async () => ({
        error: { code: `libre ${SECRET}` },
      })),
      LIGNE,
    );
    const sorties = toutesLesSorties(spies);
    expect(sorties).not.toContain(SECRET);
    expect(sorties).toContain("db_error/sans_code");
  });
});

describe("cohérence avec la migration retention_runs", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260904090000_retention_runs.sql"),
    "utf8",
  );

  it("porte une colonne pour CHAQUE champ écrit par la route", () => {
    // `LIGNE` est une LignePasse complète : ses clés SONT le contrat d'insert.
    // `publications_purged` et `batches` y figurent — un renommage d'un côté
    // sans l'autre casse ce test.
    for (const colonne of [...Object.keys(LIGNE), "ran_at"]) {
      expect(sql, `colonne absente de la migration: ${colonne}`).toMatch(
        new RegExp(`^\\s{2}${colonne}\\s`, "m"),
      );
    }
  });

  it("verrouille par CHECK exactement le vocabulaire CODES_ERREUR", () => {
    for (const code of CODES_ERREUR) {
      expect(sql, `code absent du CHECK: ${code}`).toContain(`'${code}'`);
    }
    // Et rien de plus : les littéraux entre quotes du CHECK sont tous connus.
    const bloc = sql.match(/check \(([\s\S]*?)\)\s*\)/)?.[1] ?? "";
    const litteraux = [...bloc.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(litteraux.length).toBeGreaterThan(0);
    for (const litteral of litteraux) {
      expect(CODES_ERREUR).toContain(litteral);
    }
  });
});
