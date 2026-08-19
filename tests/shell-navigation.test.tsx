/**
 * C5 — shell applicatif : navigation, route active, liens générés,
 * workspace switcher, menu utilisateur, initiales.
 *
 * Les composants client sont rendus en HTML statique (`renderToStaticMarkup`)
 * avec `usePathname` simulé : on vérifie la structure et les attributs
 * d'accessibilité réellement émis, pas des snapshots.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "@/components/shell/sidebar";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { HeaderTitle } from "@/components/shell/header-title";
import { UserMenu } from "@/components/shell/user-menu";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";
import type { WorkspaceContext } from "@/features/workspaces/context";
import { userFirstName, userLabel } from "@/features/workspaces/context";
import { initials } from "@/features/workspaces/display";
import {
  NAV_ITEMS,
  findActiveNavItem,
  isNavItemActive,
  navItemsFor,
  workspaceHref,
} from "@/features/workspaces/navigation";
import type { WorkspaceMembership } from "@/types/workspace";

// ---------------------------------------------------------------------------
// Simulations : route courante et Server Actions (jamais appelées ici)
// ---------------------------------------------------------------------------
const pathnameMock = vi.fn(() => "/app/kodeho");
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock("@/features/auth/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("@/features/workspaces/actions", () => ({ createWorkspaceAction: vi.fn() }));
vi.mock("@/features/workspaces/queries", () => ({
  requireUser: vi.fn(),
  listMemberships: vi.fn(),
}));

const memberships: WorkspaceMembership[] = [
  { role: "owner", workspace: { id: "ws-1", name: "Kodeho", slug: "kodeho" } },
  { role: "admin", workspace: { id: "ws-2", name: "Fleet", slug: "fleet" } },
  { role: "member", workspace: { id: "ws-3", name: "Automobile", slug: "automobile" } },
];

const ctx: WorkspaceContext = {
  user: { id: "user-1", email: "ludovic@example.com" },
  profile: { displayName: "Ludovic Piraino", avatarUrl: null },
  memberships,
  active: memberships[0],
};

beforeEach(() => {
  pathnameMock.mockReturnValue("/app/kodeho");
});

// ---------------------------------------------------------------------------
// Navigation (logique pure)
// ---------------------------------------------------------------------------
describe("navigation — génération des liens", () => {
  it("construit les routes relatives au workspace", () => {
    expect(workspaceHref("kodeho")).toBe("/app/kodeho");
    expect(workspaceHref("kodeho", "publish")).toBe("/app/kodeho/publish");
  });

  it("expose les huit destinations attendues, dans les bonnes sections", () => {
    expect(NAV_ITEMS.map((i) => i.segment)).toEqual([
      "",
      "publish",
      "calendar",
      "media",
      "accounts",
      "analytics",
      "settings",
      "billing",
    ]);
    expect(navItemsFor("main").map((i) => i.label)).toEqual([
      "Vue d'ensemble",
      "Publier",
      "Calendrier",
      "Médiathèque",
      "Comptes sociaux",
      "Statistiques",
    ]);
    expect(navItemsFor("secondary").map((i) => i.label)).toEqual(["Paramètres"]);
    expect(navItemsFor("footer").map((i) => i.label)).toEqual(["Abonnement"]);
  });
});

describe("navigation — route active", () => {
  const overview = NAV_ITEMS[0];
  const settings = NAV_ITEMS.find((i) => i.key === "settings")!;

  it("la vue d'ensemble n'est active que sur correspondance exacte", () => {
    expect(isNavItemActive("/app/kodeho", "kodeho", overview)).toBe(true);
    expect(isNavItemActive("/app/kodeho/", "kodeho", overview)).toBe(true);
    expect(isNavItemActive("/app/kodeho/publish", "kodeho", overview)).toBe(false);
  });

  it("une section est active sur sa route et ses sous-routes", () => {
    expect(isNavItemActive("/app/kodeho/settings", "kodeho", settings)).toBe(true);
    expect(isNavItemActive("/app/kodeho/settings/profile", "kodeho", settings)).toBe(true);
    expect(isNavItemActive("/app/kodeho/settingsx", "kodeho", settings)).toBe(false);
  });

  it("ne confond pas deux workspaces", () => {
    expect(isNavItemActive("/app/fleet/settings", "kodeho", settings)).toBe(false);
    expect(findActiveNavItem("/app/fleet", "kodeho")).toBeNull();
  });

  it("retrouve l'élément actif pour le titre du header", () => {
    expect(findActiveNavItem("/app/kodeho", "kodeho")?.label).toBe("Vue d'ensemble");
    expect(findActiveNavItem("/app/kodeho/media", "kodeho")?.label).toBe("Médiathèque");
    expect(findActiveNavItem("/app/kodeho/inconnu", "kodeho")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------
describe("initiales et libellés", () => {
  it("calcule des initiales lisibles", () => {
    expect(initials("Ludovic Piraino")).toBe("LP");
    expect(initials("Kodeho")).toBe("K");
    expect(initials("ludovic.piraino@example.com")).toBe("LP");
    expect(initials("  ")).toBe("?");
  });

  it("dérive le nom affiché et le prénom depuis les données réelles", () => {
    expect(userLabel(ctx)).toBe("Ludovic Piraino");
    expect(userFirstName(ctx)).toBe("Ludovic");
    const noName: WorkspaceContext = {
      ...ctx,
      profile: { displayName: null, avatarUrl: null },
    };
    expect(userLabel(noName)).toBe("ludovic@example.com");
  });
});

// ---------------------------------------------------------------------------
// Rendu des composants
// ---------------------------------------------------------------------------
describe("SidebarNav", () => {
  it("marque la route courante avec aria-current=page, et elle seule", () => {
    pathnameMock.mockReturnValue("/app/kodeho/calendar");
    const html = renderToStaticMarkup(
      <SidebarNav slug="kodeho" section="main" ariaLabel="Navigation principale" />,
    );
    const current = html.match(/aria-current="page"/g) ?? [];
    expect(current).toHaveLength(1);
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/app\/kodeho\/calendar"/);
    expect(html).toContain('href="/app/kodeho"');
    expect(html).toContain('aria-label="Navigation principale"');
  });

  it("génère tous les liens du workspace demandé", () => {
    const html = renderToStaticMarkup(
      <SidebarNav slug="fleet" section="main" ariaLabel="x" />,
    );
    for (const item of navItemsFor("main")) {
      expect(html).toContain(`href="${workspaceHref("fleet", item.segment)}"`);
    }
    expect(html).not.toContain("/app/kodeho");
  });
});

describe("HeaderTitle", () => {
  it("affiche le workspace et le nom de la page active", () => {
    pathnameMock.mockReturnValue("/app/kodeho/accounts");
    const html = renderToStaticMarkup(<HeaderTitle slug="kodeho" workspaceName="Kodeho" />);
    expect(html).toContain("Kodeho");
    expect(html).toContain("Comptes sociaux");
  });
});

describe("WorkspaceSwitcher", () => {
  const html = renderToStaticMarkup(
    <WorkspaceSwitcher active={memberships[0]} memberships={memberships} />,
  );

  it("affiche le workspace actif et son rôle, menu fermé par défaut", () => {
    expect(html).toContain("Kodeho");
    expect(html).toContain("Owner");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });

  it("n'expose que des workspaces issus des memberships fournies", () => {
    expect(html).not.toContain("/app/fleet");
    expect(html).not.toContain("/app/automobile");
  });

  it("propose la création d'un nouveau workspace via une boîte de dialogue", () => {
    expect(html).toContain("<dialog");
    expect(html).toContain("Nouveau workspace");
    expect(html).toContain('name="name"');
  });
});

describe("UserMenu", () => {
  it("expose le nom, l'e-mail et un menu fermé", () => {
    const html = renderToStaticMarkup(
      <UserMenu
        label="Ludovic Piraino"
        email="ludovic@example.com"
        avatarUrl={null}
        seed="user-1"
        slug="kodeho"
      />,
    );
    expect(html).toContain("Ludovic Piraino");
    expect(html).toContain("ludovic@example.com");
    expect(html).toContain("LP");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Se déconnecter");
  });
});

describe("Sidebar", () => {
  it("assemble marque, switcher, navigation et utilisateur à partir du contexte", () => {
    const html = renderToStaticMarkup(<Sidebar ctx={ctx} />);
    expect(html).toContain("POSTYNC");
    expect(html).toContain("Kodeho");
    expect(html).toContain('href="/app/kodeho/publish"');
    expect(html).toContain('href="/app/kodeho/billing"');
    expect(html).toContain("Ludovic Piraino");
    expect(html).toContain("ludovic@example.com");
    // Aucun libellé de platform_role ne doit transparaître dans le shell.
    expect(html).not.toMatch(/super_admin|platform_role/);
  });
});
