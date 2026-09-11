"use client";

import { useCallback, useRef } from "react";

import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { ALLOWED_MIME_TYPES, MAX_BYTE_SIZE, formatBytes } from "@/server/media/rules";

import { SurcoucheTeleversement } from "./upload-overlay";
import { SEUIL_REPRENABLE } from "./upload-transport";
import { useTeleversementMedia } from "./use-televersement";

/**
 * Téléversement d'un média depuis la médiathèque.
 *
 * Ce composant ne contient plus AUCUNE logique d'envoi : contrôles, ticket,
 * transport, reprise et messages vivent dans `useTeleversementMedia`, partagé
 * avec le bouton « Importer une vidéo » de la vue d'ensemble. Il ne reste ici
 * que ce qui est propre à cet écran : un champ de fichier visible et le rappel
 * des contraintes.
 *
 * Le fichier ne transite PAS par POSTYNC : le serveur délivre un ticket après
 * avoir vérifié le rôle, le format et le quota, et le navigateur envoie les
 * octets directement au stockage.
 */
export function MediaUploadForm({ workspaceSlug }: { workspaceSlug: string }) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Vider le champ après coup permet de resélectionner le MÊME fichier : sans
  // cela, `change` ne se déclencherait pas une seconde fois et un utilisateur
  // qui vient d'échouer croirait le bouton mort.
  const viderChamp = useCallback(() => {
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const etat = useTeleversementMedia({ workspaceSlug, onReinitialiser: viderChamp });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept={ALLOWED_MIME_TYPES.join(",")}
          disabled={etat.occupe}
          aria-describedby="contraintes-media"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) etat.choisir(file);
          }}
          className="text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary-hover disabled:opacity-45"
        />
        {etat.phase === "error" || etat.phase === "done" ? (
          <Button type="button" variant="secondary" size="sm" onClick={etat.reinitialiser}>
            Recommencer
          </Button>
        ) : null}
      </div>

      <p id="contraintes-media" className="text-xs text-muted">
        Vidéos MP4 ou MOV, images JPEG. {formatBytes(MAX_BYTE_SIZE)} maximum. Le fichier
        est envoyé directement au stockage, sans transiter par POSTYNC. Au-delà de{" "}
        {formatBytes(SEUIL_REPRENABLE)}, l&apos;envoi se fait par tranches et reprend
        après une coupure.
      </p>

      {etat.error ? <FormAlert tone="error">{etat.error}</FormAlert> : null}
      {etat.message ? <FormAlert tone="notice">{etat.message}</FormAlert> : null}

      <SurcoucheTeleversement etat={etat} />
    </div>
  );
}
