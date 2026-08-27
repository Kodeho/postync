"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import {
  finalizeUploadAction,
  requestUploadAction,
  IDLE_MEDIA_ACTION,
  IDLE_UPLOAD_TICKET,
} from "@/server/media/actions";
import { ALLOWED_MIME_TYPES, MAX_BYTE_SIZE, formatBytes } from "@/server/media/rules";

/**
 * Téléversement d'un média.
 *
 * Le fichier ne transite PAS par POSTYNC : le serveur délivre une URL signée
 * après avoir vérifié le rôle, le format et le quota, et le navigateur
 * téléverse directement vers le stockage. C'est ce qui permet d'accepter
 * 300 Mo sans se heurter aux limites d'une fonction serverless.
 *
 * `XMLHttpRequest` plutôt que `fetch` pour une seule raison : c'est le seul
 * moyen d'obtenir une vraie progression de téléversement dans un navigateur.
 */

type Phase = "idle" | "preparing" | "uploading" | "finalizing" | "done" | "error";

export function MediaUploadForm({ workspaceSlug }: { workspaceSlug: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);

  function reset() {
    setPhase("idle");
    setProgress(0);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function envoyer(file: File) {
    setError(null);
    setMessage(null);
    setFilename(file.name);

    // Premier filtre côté navigateur : inutile de déranger le serveur pour un
    // fichier manifestement hors limites. Le serveur revérifie tout.
    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
      setPhase("error");
      setError("Format non pris en charge. Vidéos MP4 ou MOV, images JPEG.");
      return;
    }
    if (file.size > MAX_BYTE_SIZE) {
      setPhase("error");
      setError(`Ce fichier fait ${formatBytes(file.size)} ; la limite est de 300 Mo.`);
      return;
    }

    setPhase("preparing");
    const demande = new FormData();
    demande.set("workspaceSlug", workspaceSlug);
    demande.set("filename", file.name);
    demande.set("mimeType", file.type);
    demande.set("byteSize", String(file.size));

    const ticket = await requestUploadAction(IDLE_UPLOAD_TICKET, demande);
    if (ticket.error || !ticket.ticket) {
      setPhase("error");
      setError(ticket.error ?? "Le téléversement n'a pas pu être préparé.");
      return;
    }

    setPhase("uploading");
    setProgress(0);
    try {
      await televerser(ticket.ticket.uploadUrl, file, setProgress);
    } catch {
      setPhase("error");
      setError("Le transfert du fichier a échoué. Réessayez.");
      return;
    }

    // Le serveur confirme la présence du fichier et le MESURE lui-même.
    setPhase("finalizing");
    const confirmation = new FormData();
    confirmation.set("workspaceSlug", workspaceSlug);
    confirmation.set("assetId", ticket.ticket.assetId);
    const finalise = await finalizeUploadAction(IDLE_MEDIA_ACTION, confirmation);

    if (finalise.error) {
      setPhase("error");
      setError(finalise.error);
      return;
    }
    setPhase("done");
    setMessage(finalise.notice);
    if (inputRef.current) inputRef.current.value = "";
  }

  const occupe = phase === "preparing" || phase === "uploading" || phase === "finalizing";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept={ALLOWED_MIME_TYPES.join(",")}
          disabled={occupe}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void envoyer(file);
          }}
          className="text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary-hover disabled:opacity-60"
        />
        {phase === "error" || phase === "done" ? (
          <Button type="button" variant="secondary" size="sm" onClick={reset}>
            Recommencer
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted">
        Vidéos MP4 ou MOV, images JPEG. 300 Mo maximum. Le fichier est envoyé
        directement au stockage, sans transiter par POSTYNC.
      </p>

      {occupe ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>
              {phase === "preparing"
                ? "Préparation…"
                : phase === "uploading"
                  ? `Envoi de « ${filename} »`
                  : "Analyse du fichier…"}
            </span>
            {phase === "uploading" ? <span>{progress}%</span> : null}
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
            role="progressbar"
            aria-valuenow={phase === "uploading" ? progress : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: phase === "uploading" ? `${progress}%` : "100%" }}
            />
          </div>
        </div>
      ) : null}

      {error ? <FormAlert tone="error">{error}</FormAlert> : null}
      {message ? <FormAlert tone="notice">{message}</FormAlert> : null}
    </div>
  );
}

/** Téléversement avec progression réelle. */
function televerser(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("content-type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("réseau"));
    xhr.send(file);
  });
}
