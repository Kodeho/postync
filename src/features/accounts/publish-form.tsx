"use client";

import { useActionState, useState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { TextField } from "@/components/ui/text-field";
import { publishAction, resumePublicationAction } from "@/server/social/actions";
import { IDLE_PUBLISH_ACTION } from "@/server/social/action-state";

/** Média proposé au choix, avec sa compatibilité pour CE réseau. */
export type SelectableMedia = {
  id: string;
  label: string;
  compatible: boolean;
  reasons: string[];
};

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
/**
 * Contraintes de média, par plateforme. Elles diffèrent nettement : un Reel
 * Facebook impose le 9:16 et 90 secondes là où Instagram accepte presque tout
 * ratio jusqu'à 15 minutes. Afficher les mêmes règles partout induirait
 * l'utilisateur en erreur.
 */
const MEDIA_HINTS: Record<string, { reel: string; image: string }> = {
  instagram: {
    reel: "MP4 ou MOV, H264 ou HEVC, 3 s à 15 min, 300 Mo maximum, 9:16 recommandé.",
    image: "JPEG uniquement.",
  },
  facebook: {
    reel: "MP4, H264 ou HEVC, 3 à 90 s, ratio 9:16 OBLIGATOIRE, minimum 540 × 960, 24 à 60 FPS.",
    image: "Non pris en charge pour l'instant sur les Pages.",
  },
};

export function PublishForm({
  workspaceSlug,
  platform,
  accountId,
  accountLabel,
  disabledReason,
  media,
}: {
  workspaceSlug: string;
  platform: string;
  accountId: string;
  accountLabel: string;
  /** Non nul : la publication est impossible et la raison est affichée. */
  disabledReason: string | null;
  /** Médias prêts de la bibliothèque, avec leur compatibilité. */
  media: SelectableMedia[];
}) {
  const [state, action] = useActionState(publishAction, IDLE_PUBLISH_ACTION);
  const [resumeState, resumeAction] = useActionState(resumePublicationAction, IDLE_PUBLISH_ACTION);
  const [mediaKind, setMediaKind] = useState<"reel" | "image">("reel");
  const [open, setOpen] = useState(false);
  // La bibliothèque est la voie normale ; l'URL externe reste disponible tant
  // que la transition n'est pas terminée.
  const [source, setSource] = useState<"library" | "url">(media.length > 0 ? "library" : "url");
  const [assetId, setAssetId] = useState<string>(
    media.find((m) => m.compatible)?.id ?? "",
  );
  const choisi = media.find((m) => m.id === assetId) ?? null;

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

        {media.length > 0 ? (
          <fieldset className="flex flex-col gap-1.5 text-sm">
            <legend className="font-medium text-foreground">Source du média</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name="mediaSource"
                  value="library"
                  checked={source === "library"}
                  onChange={() => setSource("library")}
                />
                Médiathèque
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name="mediaSource"
                  value="url"
                  checked={source === "url"}
                  onChange={() => setSource("url")}
                />
                URL externe
              </label>
            </div>
          </fieldset>
        ) : null}

        {source === "library" && media.length > 0 ? (
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">Média</span>
            <select
              name="mediaAssetId"
              value={assetId}
              onChange={(event) => setAssetId(event.target.value)}
              className="rounded-md border border-border bg-surface px-3 py-2 text-foreground shadow-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
            >
              <option value="">Choisir un média…</option>
              {media.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.compatible}>
                  {item.label}
                  {item.compatible ? "" : " — non compatible"}
                </option>
              ))}
            </select>
            {choisi && !choisi.compatible ? (
              // Expliquer plutôt que d'échouer après coup.
              <span className="text-xs text-danger">{choisi.reasons.join(" ")}</span>
            ) : (
              <span className="text-xs text-muted">
                Importez vos médias depuis la Médiathèque pour les retrouver ici.
              </span>
            )}
          </label>
        ) : (
          <TextField
            label="URL publique du média"
            name="mediaUrl"
            type="url"
            required
            placeholder="https://exemple.com/video.mp4"
            hint={(MEDIA_HINTS[platform] ?? MEDIA_HINTS.instagram)[mediaKind]}
          />
        )}

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
          {source === "library" && (!choisi || !choisi.compatible) ? (
            <button
              type="button"
              disabled
              title={choisi ? choisi.reasons.join(" ") : "Choisissez un média compatible"}
              className="inline-flex h-10 cursor-not-allowed items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground opacity-60"
            >
              Publier
            </button>
          ) : (
            <SubmitButton label="Publier" pendingLabel="Publication…" />
          )}
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
