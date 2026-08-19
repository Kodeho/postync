"use client";

import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";

import { Avatar } from "@/components/ui/avatar";
import { CreateWorkspaceForm } from "@/features/workspaces/create-workspace-form";
import { WORKSPACE_ROLE_LABELS } from "@/features/workspaces/display";
import { workspaceHref } from "@/features/workspaces/navigation";
import type { WorkspaceMembership } from "@/types/workspace";

import { useDismissable } from "./use-dismissable";

type WorkspaceSwitcherProps = {
  active: WorkspaceMembership;
  /** Toutes les memberships réelles de l'utilisateur (lues sous RLS). */
  memberships: WorkspaceMembership[];
};

/**
 * Sélecteur de workspace.
 *
 * La liste vient exclusivement des memberships résolues côté serveur ; changer
 * de workspace = naviguer vers `/app/<slug>`, route qui revérifie
 * l'appartenance. « Nouveau workspace » ouvre une boîte de dialogue native
 * contenant le formulaire C4 (RPC `create_workspace`).
 */
export function WorkspaceSwitcher({ active, memberships }: WorkspaceSwitcherProps) {
  const { open, toggle, close, containerRef, triggerRef } = useDismissable();
  const dialogRef = useRef<HTMLDialogElement>(null);

  function openDialog() {
    close();
    dialogRef.current?.showModal();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Workspace actif : ${active.workspace.name}. Changer de workspace`}
        className="flex w-full items-center gap-3 rounded-md border border-border bg-surface px-2.5 py-2 text-left shadow-soft transition-colors hover:bg-surface-muted"
      >
        <Avatar
          label={active.workspace.name}
          seed={active.workspace.id}
          shape="square"
          size="md"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">
            {active.workspace.name}
          </span>
          <span className="block text-xs text-muted">
            {WORKSPACE_ROLE_LABELS[active.role]}
          </span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Workspaces"
          className="animate-fade-in absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-md border border-border bg-surface p-1 shadow-pop"
        >
          <ul className="max-h-72 overflow-y-auto">
            {memberships.map((m) => {
              const current = m.workspace.id === active.workspace.id;
              return (
                <li key={m.workspace.id}>
                  <Link
                    role="menuitem"
                    href={workspaceHref(m.workspace.slug)}
                    aria-current={current ? "true" : undefined}
                    onClick={() => close()}
                    className="flex items-center gap-3 rounded-sm px-2 py-2 text-sm hover:bg-surface-muted"
                  >
                    <Avatar
                      label={m.workspace.name}
                      seed={m.workspace.id}
                      shape="square"
                      size="sm"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">
                        {m.workspace.name}
                      </span>
                      <span className="block text-xs text-muted">
                        {WORKSPACE_ROLE_LABELS[m.role]}
                      </span>
                    </span>
                    {current ? (
                      <Check aria-hidden="true" className="h-4 w-4 text-primary" />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={openDialog}
            className="flex w-full items-center gap-3 rounded-sm px-2 py-2 text-sm font-medium text-foreground hover:bg-surface-muted"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-dashed border-border-strong text-muted">
              <Plus aria-hidden="true" className="h-4 w-4" />
            </span>
            Nouveau workspace
          </button>
        </div>
      ) : null}

      <dialog
        ref={dialogRef}
        aria-labelledby="new-workspace-title"
        className="m-auto w-[calc(100vw-2rem)] max-w-sm rounded-lg border border-border bg-surface p-0 text-foreground shadow-pop backdrop:bg-foreground/40"
      >
        <div className="p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 id="new-workspace-title" className="text-lg font-semibold tracking-tight">
                Nouveau workspace
              </h2>
              <p className="mt-1 text-sm text-muted">
                Un espace isolé, avec ses propres comptes et publications.
              </p>
            </div>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="Fermer"
              className="rounded-md p-1 text-muted hover:bg-surface-muted hover:text-foreground"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
          <CreateWorkspaceForm submitLabel="Créer le workspace" pendingLabel="Création…" />
        </div>
      </dialog>
    </div>
  );
}
