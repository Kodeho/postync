/**
 * C4 — logique pure des workspaces : validation du nom, validation du slug
 * d'URL, résolution du workspace actif et redirection de `/app`.
 */
import { describe, expect, it } from "vitest";

import {
  findMembershipBySlug,
  resolveAppRedirect,
} from "@/features/workspaces/resolve";
import {
  isValidWorkspaceSlug,
  validateWorkspaceName,
} from "@/features/workspaces/validation";
import type { WorkspaceMembership } from "@/types/workspace";

const memberships: WorkspaceMembership[] = [
  { role: "owner", workspace: { id: "1", name: "Kodeho", slug: "kodeho" } },
  { role: "member", workspace: { id: "2", name: "Fleet", slug: "fleet" } },
];

function form(name: string): FormData {
  const f = new FormData();
  f.set("name", name);
  return f;
}

describe("validateWorkspaceName", () => {
  it("accepte un nom et le normalise (trim)", () => {
    expect(validateWorkspaceName(form("  Kodeho  "))).toEqual({
      ok: true,
      value: "Kodeho",
    });
  });

  it("refuse un nom vide", () => {
    expect(validateWorkspaceName(form("   ")).ok).toBe(false);
    expect(validateWorkspaceName(new FormData()).ok).toBe(false);
  });

  it("refuse un nom de plus de 80 caractères", () => {
    expect(validateWorkspaceName(form("x".repeat(81))).ok).toBe(false);
    expect(validateWorkspaceName(form("x".repeat(80))).ok).toBe(true);
  });
});

describe("isValidWorkspaceSlug", () => {
  it("accepte le format produit par la base", () => {
    for (const slug of ["kodeho", "kodeho-2", "mon-agence-ephemere-co", "a1"]) {
      expect(isValidWorkspaceSlug(slug), slug).toBe(true);
    }
  });

  it("rejette tout ce que la base ne produirait jamais", () => {
    for (const slug of [
      "",
      "Kodeho",
      "-kodeho",
      "kodeho-",
      "ko--deho",
      "ko deho",
      "ko/deho",
      "../etc",
      "k".repeat(61),
    ]) {
      expect(isValidWorkspaceSlug(slug), JSON.stringify(slug)).toBe(false);
    }
  });
});

describe("findMembershipBySlug", () => {
  it("retourne la membership du workspace demandé", () => {
    expect(findMembershipBySlug(memberships, "fleet")).toEqual(memberships[1]);
  });

  it("retourne null pour un slug inconnu ou mal formé", () => {
    expect(findMembershipBySlug(memberships, "automobile")).toBeNull();
    expect(findMembershipBySlug(memberships, "Kodeho")).toBeNull();
    expect(findMembershipBySlug(memberships, "")).toBeNull();
  });

  it("retourne null sans aucune membership", () => {
    expect(findMembershipBySlug([], "kodeho")).toBeNull();
  });
});

describe("resolveAppRedirect", () => {
  it("dirige vers /onboarding sans workspace", () => {
    expect(resolveAppRedirect([])).toBe("/onboarding");
  });

  it("dirige vers le premier workspace (le plus ancien)", () => {
    expect(resolveAppRedirect(memberships)).toBe("/app/kodeho");
  });
});
