"use client";

import { useActionState, useState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { instantToWallClock, wallClockToInstant } from "@/lib/time-zone";
import { reschedulePublicationAction } from "@/server/social/actions";
import { IDLE_SOCIAL_ACTION } from "@/server/social/action-state";

/**
 * Déplacer l'échéance d'une publication programmée.
 *
 * CE QUE CELA REMPLACE. Sans ce contrôle, changer l'heure d'une publication
 * imposait de l'annuler puis de tout ressaisir — média, texte, compte cible —
 * alors que rien de tout cela ne change. Un détour de cette taille finit par
 * décourager la programmation elle-même.
 *
 * LE FUSEAU EST CELUI DU WORKSPACE, jamais celui du navigateur. Un champ
 * `datetime-local` ne porte aucun fuseau : « 14:30 » y est une heure murale.
 * C'est la même règle que le formulaire de publication, et c'est la seule
 * cohérente avec le calendrier qui l'affiche juste à côté — sans quoi un
 * client à Montréal déplacerait une publication de six heures sans le vouloir.
 */
export function RescheduleButton({
  workspaceSlug,
  publicationId,
  currentIso,
  timeZone,
}: {
  workspaceSlug: string;
  publicationId: string;
  /** Échéance actuelle, pour préremplir le champ. */
  currentIso: string;
  timeZone: string;
}) {
  const [state, action] = useActionState(reschedulePublicationAction, IDLE_SOCIAL_ACTION);
  const [ouvert, setOuvert] = useState(false);
  const [valeur, setValeur] = useState("");
  const [bornes, setBornes] = useState<{ min: string; max: string } | null>(null);

  // Lire l'heure courante pendant le rendu divergerait entre serveur et
  // navigateur : les bornes sont calculées dans le gestionnaire d'événement.
  function ouvrir() {
    const maintenant = Date.now();
    setBornes({
      min: instantToWallClock(maintenant + 6 * 60_000, timeZone),
      max: instantToWallClock(maintenant + 364 * 24 * 3600_000, timeZone),
    });
    setValeur(instantToWallClock(Date.parse(currentIso), timeZone));
    setOuvert(true);
  }

  if (!ouvert) {
    return (
      <button
        type="button"
        onClick={ouvrir}
        className="self-start text-[11px] text-muted underline-offset-2 hover:text-primary hover:underline"
      >
        Reprogrammer
      </button>
    );
  }

  const iso = valeur ? (wallClockToInstant(valeur, timeZone)?.toISOString() ?? "") : "";

  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <input type="hidden" name="publicationId" value={publicationId} />
      <input type="hidden" name="scheduledAt" value={iso} />
      <input
        type="datetime-local"
        aria-label="Nouvelle échéance"
        value={valeur}
        min={bornes?.min}
        max={bornes?.max}
        onChange={(event) => setValeur(event.target.value)}
        className="rounded border border-border bg-surface px-1.5 py-1 text-[11px] text-foreground"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={iso.length === 0}
          className="text-[11px] font-medium text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
        >
          Déplacer
        </button>
        <button
          type="button"
          onClick={() => setOuvert(false)}
          className="text-[11px] text-muted underline-offset-2 hover:underline"
        >
          Renoncer
        </button>
      </div>
      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}
    </form>
  );
}
