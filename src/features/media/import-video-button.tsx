"use client";

import Link from "next/link";
import { Upload } from "lucide-react";
import { useCallback, useId, useRef } from "react";

import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { workspaceHref } from "@/features/workspaces/navigation";
import { MAX_BYTE_SIZE, VIDEO_MIME_TYPES, formatBytes } from "@/server/media/rules";

import { SurcoucheTeleversement } from "./upload-overlay";
import { useTeleversementMedia } from "./use-televersement";

/**
 * « Importer une vidéo » — raccourci depuis la vue d'ensemble.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LE MÊME PARCOURS, PAS UN SECOND
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Tout ce qui décide — contrôle du format, contrôle de la taille, ticket
 * signé, transport reprenable, reprise, finalisation, messages d'erreur — vient
 * de `useTeleversementMedia`, exactement le même hook que la médiathèque. Ce
 * fichier n'ajoute qu'un bouton et un champ masqué. Si le transport change
 * demain, les deux écrans changent ensemble ou aucun ne change.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI UN CHAMP MASQUÉ PLUTÔT QU'UN `<input type=file>` STYLÉ
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Un champ de fichier natif ne se met pas au gabarit de la charte : son bouton
 * interne est dessiné par le navigateur et diffère d'un système à l'autre. On
 * garde donc un vrai `<button>` — donc la charte, les états de survol, de
 * focus et de désactivation, et l'activation au clavier par Entrée comme par
 * Espace — et on lui délègue l'ouverture du sélecteur.
 *
 * Le champ reste dans le DOM mais hors du parcours de tabulation et masqué aux
 * lecteurs d'écran : sans cela, il serait annoncé une seconde fois, sous un nom
 * générique, juste après le bouton qui le commande.
 *
 * Il n'est PAS caché par `display:none`. Un champ ainsi masqué reste
 * cliquable par script sur les navigateurs courants, mais la technique est
 * fragile et casse l'ouverture du sélecteur sur certains mobiles ; la classe
 * `sr-only` le retire de l'affichage sans le retirer du rendu.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUE CE BOUTON NE FAIT PAS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Il n'ouvre aucun formulaire de publication et ne contacte aucun réseau. La
 * vidéo rejoint la médiathèque, un point c'est tout : la publication reste une
 * décision séparée, prise ailleurs et explicitement.
 */
export function ImportVideoButton({ workspaceSlug }: { workspaceSlug: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const idAide = useId();

  const viderChamp = useCallback(() => {
    // Indispensable pour pouvoir reprendre le MÊME fichier après un échec :
    // sans remise à zéro, `change` ne se déclenche pas deux fois de suite.
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const etat = useTeleversementMedia({ workspaceSlug, onReinitialiser: viderChamp });

  return (
    <div className="flex min-w-0 flex-col items-stretch gap-2 sm:items-end">
      <Button
        type="button"
        variant="primary"
        onClick={() => inputRef.current?.click()}
        disabled={etat.occupe}
        loading={etat.occupe}
        loadingLabel="Envoi en cours…"
        aria-describedby={idAide}
      >
        <Upload aria-hidden="true" className="h-4 w-4" />
        Importer une vidéo
      </Button>

      {/*
        Hors tabulation et hors lecteur d'écran : c'est le bouton ci-dessus qui
        porte le nom accessible et l'action. Le champ n'est qu'un mécanisme.
      */}
      <input
        ref={inputRef}
        type="file"
        /*
          VIDÉO seulement : le libellé promet une vidéo, le sélecteur doit
          proposer une vidéo. Si un utilisateur force malgré tout un autre
          format via « tous les fichiers », c'est le contrôle partagé du hook
          qui tranche — il n'existe pas de second jeu de règles ici.
        */
        accept={VIDEO_MIME_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) etat.choisir(file);
        }}
      />

      {/*
        Contraintes annoncees au lecteur d'ecran, pas affichees : dans une zone
        d'actions, un paragraphe sous le bouton alourdirait l'en-tete de la page
        alors que le sélecteur de fichiers filtre deja les formats. L'information
        reste due a qui ne voit pas ce filtrage.
      */}
      <p id={idAide} className="sr-only">
        Formats acceptés : MP4 ou MOV. Taille maximale {formatBytes(MAX_BYTE_SIZE)}.
        La vidéo est ajoutée à la médiathèque, sans publication sur un réseau social.
      </p>

      {/*
        Le message vit ICI, à côté du bouton : la surcouche s'est fermée à la
        réussite, et une confirmation qui disparaît avec elle n'aurait jamais
        été lue. Le lien accompagne l'annonce — voir le média ajouté est le
        geste suivant le plus probable.
      */}
      {etat.message ? (
        <FormAlert tone="notice">
          {etat.message}{" "}
          <Link
            href={workspaceHref(workspaceSlug, "media")}
            className="underline underline-offset-2"
          >
            Voir la médiathèque
          </Link>
        </FormAlert>
      ) : null}
      {etat.error ? <FormAlert tone="error">{etat.error}</FormAlert> : null}

      <SurcoucheTeleversement etat={etat} />
    </div>
  );
}
