/**
 * C6 — administration Kodeho : matrice de permissions (copie applicative de
 * la matrice imposée en base), résumés d'audit, configuration des plans et
 * navigation admin. Logique pure.
 */
import { describe, expect, it } from "vitest";

import {
  ADMIN_NAV,
  adminNavFor,
  findActiveAdminNavItem,
  isAdminNavActive,
} from "@/components/admin/admin-navigation";
import { PLANS, formatPlanPrice, getPlan } from "@/config/plans";
import { auditActionLabel, summarizeAudit } from "@/server/admin/audit";
import {
  assignableRoles,
  can,
  decideRoleChange,
  decideStatusChange,
  isPlatformStaff,
} from "@/server/admin/permissions";
import { isFullAccessActive } from "@/server/admin/queries";

describe("matrice de permissions", () => {
  it("user n'est pas du personnel plateforme ; support, admin, super_admin le sont", () => {
    expect(isPlatformStaff("user")).toBe(false);
    expect(isPlatformStaff("support")).toBe(true);
    expect(isPlatformStaff("admin")).toBe(true);
    expect(isPlatformStaff("super_admin")).toBe(true);
    expect(isPlatformStaff(null)).toBe(false);
  });

  it("support : lecture seule", () => {
    expect(can("support", "users.read")).toBe(true);
    expect(can("support", "workspaces.read")).toBe(true);
    expect(can("support", "users.suspend")).toBe(false);
    expect(can("support", "users.change_role")).toBe(false);
    expect(can("support", "workspaces.full_access")).toBe(false);
    expect(can("support", "audit.read")).toBe(false);
  });

  it("admin et super_admin : actions sensibles autorisées ; user : rien", () => {
    for (const role of ["admin", "super_admin"] as const) {
      expect(can(role, "users.suspend")).toBe(true);
      expect(can(role, "users.reactivate")).toBe(true);
      expect(can(role, "workspaces.full_access")).toBe(true);
      expect(can(role, "audit.read")).toBe(true);
      expect(can(role, "users.change_role")).toBe(true);
    }
    expect(can("user", "users.read")).toBe(false);
    expect(can("user", "audit.read")).toBe(false);
  });
});

describe("décisions : statut de compte", () => {
  it("admin suspend un utilisateur standard", () => {
    expect(decideStatusChange({ actorRole: "admin", targetRole: "user", isSelf: false })).toEqual({
      allowed: true,
    });
  });

  it("support ne suspend personne", () => {
    expect(decideStatusChange({ actorRole: "support", targetRole: "user", isSelf: false }).allowed).toBe(false);
  });

  it("personne ne modifie son propre statut ; admin ne touche pas un super_admin", () => {
    expect(decideStatusChange({ actorRole: "admin", targetRole: "admin", isSelf: true }).allowed).toBe(false);
    expect(decideStatusChange({ actorRole: "admin", targetRole: "super_admin", isSelf: false }).allowed).toBe(false);
    expect(decideStatusChange({ actorRole: "super_admin", targetRole: "super_admin", isSelf: false }).allowed).toBe(true);
  });
});

describe("décisions : rôle plateforme", () => {
  it("admin attribue user / support / admin, jamais super_admin", () => {
    for (const newRole of ["user", "support", "admin"] as const) {
      expect(decideRoleChange({ actorRole: "admin", targetRole: "user", newRole, isSelf: false }).allowed).toBe(true);
    }
    expect(decideRoleChange({ actorRole: "admin", targetRole: "user", newRole: "super_admin", isSelf: false }).allowed).toBe(false);
  });

  it("admin ne modifie pas un super_admin ni son propre rôle", () => {
    expect(decideRoleChange({ actorRole: "admin", targetRole: "super_admin", newRole: "admin", isSelf: false }).allowed).toBe(false);
    expect(decideRoleChange({ actorRole: "admin", targetRole: "admin", newRole: "super_admin", isSelf: true }).allowed).toBe(false);
  });

  it("super_admin gère super_admin (sauf lui-même)", () => {
    expect(decideRoleChange({ actorRole: "super_admin", targetRole: "admin", newRole: "super_admin", isSelf: false }).allowed).toBe(true);
    expect(decideRoleChange({ actorRole: "super_admin", targetRole: "super_admin", newRole: "admin", isSelf: false }).allowed).toBe(true);
    // Démission d'un super_admin : autorisée côté application ; la base refuse
    // s'il est le dernier super_admin actif.
    expect(decideRoleChange({ actorRole: "super_admin", targetRole: "super_admin", newRole: "admin", isSelf: true }).allowed).toBe(true);
  });

  it("liste des rôles attribuables par cible", () => {
    expect(assignableRoles({ actorRole: "admin", targetRole: "user", isSelf: false })).toEqual(["support", "admin"]);
    expect(assignableRoles({ actorRole: "admin", targetRole: "super_admin", isSelf: false })).toEqual([]);
    expect(assignableRoles({ actorRole: "super_admin", targetRole: "user", isSelf: false })).toEqual([
      "support",
      "admin",
      "super_admin",
    ]);
    expect(assignableRoles({ actorRole: "support", targetRole: "user", isSelf: false })).toEqual([]);
  });
});

describe("audit", () => {
  it("libelle et résume les actions connues", () => {
    expect(auditActionLabel("user.suspended")).toBe("Compte suspendu");
    expect(auditActionLabel("x.y")).toBe("x.y");
    expect(summarizeAudit("user.role_changed", { from: "user", to: "admin" })).toBe("user → admin");
    expect(summarizeAudit("user.suspended", { from: "active", to: "suspended" })).toBe("active → suspended");
    expect(summarizeAudit("workspace.full_access_granted", { ends_at: null, reason: "Partenaire" })).toBe(
      "sans expiration — Partenaire",
    );
    expect(summarizeAudit("workspace.full_access_granted", { ends_at: "2026-12-31T23:59:59.000Z" })).toMatch(
      /jusqu'au 31 déc\. 2026/,
    );
    expect(summarizeAudit("workspace.full_access_revoked", {})).toBe("");
  });
});

describe("Full Access effectif", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");
  it("dépend du mode et de la date de fin", () => {
    expect(isFullAccessActive("standard", null, now)).toBe(false);
    expect(isFullAccessActive("full_access", null, now)).toBe(true);
    expect(isFullAccessActive("full_access", "2026-12-31T00:00:00.000Z", now)).toBe(true);
    expect(isFullAccessActive("full_access", "2026-01-01T00:00:00.000Z", now)).toBe(false);
  });
});

describe("plans", () => {
  it("quatre offres, prix et quotas de référence", () => {
    expect(PLANS.map((p) => p.name)).toEqual(["Free", "Creator", "Pro", "Agency"]);
    expect(getPlan("creator").monthlyPriceCents).toBe(1290);
    expect(getPlan("agency").quotas).toEqual({
      workspaces: 20,
      socialAccounts: 100,
      publicationsPerMonth: 2000,
      storageGb: 250,
    });
    expect(formatPlanPrice(0)).toBe("0 €");
    expect(formatPlanPrice(2990).replace(/ | /g, " ")).toBe("29,90 €");
  });
});

describe("navigation admin", () => {
  it("sept entrées ; l'audit est masqué au support", () => {
    expect(ADMIN_NAV.map((i) => i.href)).toEqual([
      "/admin",
      "/admin/users",
      "/admin/workspaces",
      "/admin/subscriptions",
      "/admin/plans",
      "/admin/platform",
      "/admin/audit",
    ]);
    expect(adminNavFor(false).some((i) => i.key === "audit")).toBe(false);
    expect(adminNavFor(true).some((i) => i.key === "audit")).toBe(true);
  });

  it("route active : dashboard exact, sections par préfixe", () => {
    const dashboard = ADMIN_NAV[0];
    const users = ADMIN_NAV[1];
    expect(isAdminNavActive("/admin", dashboard)).toBe(true);
    expect(isAdminNavActive("/admin/users", dashboard)).toBe(false);
    expect(isAdminNavActive("/admin/users/abc", users)).toBe(true);
    expect(findActiveAdminNavItem("/admin/workspaces/x")?.key).toBe("workspaces");
    expect(findActiveAdminNavItem("/app/kodeho")).toBeNull();
  });
});
