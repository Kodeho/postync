"use client";

import { useActionState, useState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { TextField } from "@/components/ui/text-field";
import { publishAction, resumePublicationAction } from "@/server/social/actions";
import { IDLE_PUBLISH_ACTION } from "@/server/social/action-state";

/**
 * Formulaire de publication d'un compte social connecté.
 *
 * Le navigateur n'envoie que le slug du workspace, l'identifiant du compte,
 * le type de média, une URL publique et une légende. Tout est revérifié côté
 * serveur : appartenance du compte au workspace, rôle, scopes réellement
 * accordés, quota du plan.
 *
 * Le média n'est PAS téléversé par POSTYNC : Instagram exige une URL publique
 * qu'il va chercher lui-même. Tant que l'étape « media » n'apporte pas de
 * stockage, l'URL est saisie à la main.
 */
export function PublishForm({
  workspaceSlug,
  accountId,
  accountLabel,
  disabledReason,
}: {
  workspaceSlug: string;
  accountId: string;
  accountLabel: string;
  /** Non nul : la publication est impossible et la raison est affichée. */
  disabledReason: string | null;
}) {
  const [state, action] = useActionState(publishAction, IDLE_PUBLISH_ACTION);
  const [resumeState, resumeAction] = useActionState(resumePublicationAction, IDLE_PUBLISH_ACTION);
  const [mediaKind, setMediaKind] = useState<"reel" | "image">("reel");
  const [open, setOpen] = useState(false);

  // La reprise, quand elle a eu lieu, décrit l'état le plus récent.
  const current = resumeState.status || resumeState.error ? resumeState : state;

  if (disabledReason) {
    return <p className="text-xs text-muted">{disabledReason}</p>;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-xs font-medium text-primary underline-offset-2 hover:underline"
      >
        Publier sur {accountLabel}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-muted p-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
        <input type="hidden" name="accountId" value={accountId} />

        <fieldset className="flex flex-col gap-1.5 text-sm">
          <legend className="font-medium text-foreground">Type de média</legend>
          <div className="flex gap-4">
            {(["reel", "image"] as const).map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name="mediaKind"
                  value={kind}
                  checked={mediaKind === kind}
                  onChange={() => setMediaKind(kind)}
                />
                {kind === "reel" ? "Reel" : "Image"}
              </label>
            ))}
          </div>
        </fieldset>

        <TextField
          label="URL publique du média"
          name="mediaUrl"
          type="url"
          required
          placeholder="https://exemple.com/video.mp4"
          hint={
            mediaKind === "reel"
              ? "MP4 ou MOV, H264 ou HEVC, 3 s à 15 min, 300 Mo maximum, 9:16 recommandé."
              : "JPEG uniquement."
          }
        />

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Légende</span>
          <textarea
            name="caption"
            rows={3}
            maxLength={2200}
            placeholder="Facultative — 2200 caractères, 30 hashtags, 20 mentions maximum."
            className="rounded-md border border-border bg-surface px-3 py-2 text-foreground shadow-soft transition-colors placeholder:text-muted-soft hover:border-border-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
          />
        </label>

        {mediaKind === "reel" ? (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" name="shareToFeed" defaultChecked />
            Afficher aussi dans le fil
          </label>
        ) : null}

        <div className="flex items-center gap-3">
          <SubmitButton label="Publier" pendingLabel="Publication…" />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-xs text-muted underline-offset-2 hover:underline"
          >
            Annuler
          </button>
        </div>
      </form>

      {current.error ? <FormAlert tone="error">{current.error}</FormAlert> : null}

      {current.status === "published" ? (
        <FormAlert tone="notice">
          Publié.{" "}
          {current.permalink ? (
            <a
              href={current.permalink}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              Voir la publication
            </a>
          ) : null}
        </FormAlert>
      ) : null}

      {current.status === "pending" && current.publicationId ? (
        <div className="flex flex-col gap-2">
          <FormAlert tone="notice">
            La plateforme prépare encore le média. La publication reprendra sans réenvoyer le
            fichier.
          </FormAlert>
          <form action={resumeAction}>
            <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
            <input type="hidden" name="publicationId" value={current.publicationId} />
            <SubmitButton label="Reprendre" pendingLabel="Vérification…" />
          </form>
        </div>
      ) : null}
    </div>
  );
}

/** Reprise d'une publication listée dans l'historique. */
export function ResumePublicationButton({
  workspaceSlug,
  publicationId,
}: {
  workspaceSlug: string;
  publicationId: string;
}) {
  const [state, action] = useActionState(resumePublicationAction, IDLE_PUBLISH_ACTION);

  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <input type="hidden" name="publicationId" value={publicationId} />
      <SubmitButton label="Reprendre" pendingLabel="Vérification…" />
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
    </form>
  );
}
