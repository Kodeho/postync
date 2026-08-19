"use client";

import { ChevronsUpDown, LogOut, Settings, UserRound } from "lucide-react";
import Link from "next/link";

import { Avatar } from "@/components/ui/avatar";
import { signOutAction } from "@/features/auth/actions";
import { workspaceHref } from "@/features/workspaces/navigation";

import { useDismissable } from "./use-dismissable";

type UserMenuProps = {
  /** Nom affiché (display_name, sinon e-mail). */
  label: string;
  email: string | null;
  avatarUrl: string | null;
  /** Graine de couleur d'avatar (id utilisateur). */
  seed: string;
  /** Slug du workspace actif : les liens du menu lui sont relatifs. */
  slug: string;
  /** `full` : bloc avec nom et e-mail (sidebar) ; `compact` : avatar seul (header). */
  variant?: "full" | "compact";
  /** Ouverture vers le haut (bas de sidebar) ou vers le bas (header). */
  placement?: "top" | "bottom";
};

export function UserMenu({
  label,
  email,
  avatarUrl,
  seed,
  slug,
  variant = "full",
  placement = "top",
}: UserMenuProps) {
  const { open, toggle, close, containerRef, triggerRef } = useDismissable();
  const settingsHref = workspaceHref(slug, "settings");

  const menuPosition =
    placement === "top"
      ? "bottom-full left-0 right-0 mb-1.5"
      : "right-0 top-full mt-1.5 w-64";

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Menu utilisateur : ${label}`}
        className={
          variant === "full"
            ? "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-muted"
            : "rounded-full transition-opacity hover:opacity-85"
        }
      >
        <Avatar label={label} seed={seed} src={avatarUrl} size={variant === "full" ? "md" : "sm"} />
        {variant === "full" ? (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">{label}</span>
              {email ? (
                <span className="block truncate text-xs text-muted">{email}</span>
              ) : null}
            </span>
            <ChevronsUpDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
          </>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Menu utilisateur"
          className={`animate-fade-in absolute z-30 overflow-hidden rounded-md border border-border bg-surface p-1 shadow-pop ${menuPosition}`}
        >
          <div className="px-2 py-2">
            <p className="truncate text-sm font-medium text-foreground">{label}</p>
            {email ? <p className="truncate text-xs text-muted">{email}</p> : null}
          </div>
          <div className="my-1 border-t border-border" />
          <MenuLink href={`${settingsHref}#profil`} onClick={() => close()}>
            <UserRound aria-hidden="true" className="h-4 w-4 text-muted" />
            Mon profil
          </MenuLink>
          <MenuLink href={settingsHref} onClick={() => close()}>
            <Settings aria-hidden="true" className="h-4 w-4 text-muted" />
            Paramètres
          </MenuLink>
          <div className="my-1 border-t border-border" />
          <form action={signOutAction}>
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-3 rounded-sm px-2 py-2 text-sm text-foreground hover:bg-surface-muted"
            >
              <LogOut aria-hidden="true" className="h-4 w-4 text-muted" />
              Se déconnecter
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function MenuLink({
  href,
  onClick,
  children,
}: {
  href: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      role="menuitem"
      href={href}
      onClick={onClick}
      className="flex items-center gap-3 rounded-sm px-2 py-2 text-sm text-foreground hover:bg-surface-muted"
    >
      {children}
    </Link>
  );
}
