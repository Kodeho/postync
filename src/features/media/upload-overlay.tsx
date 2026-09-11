"use client";

import { BusyOverlay } from "@/components/ui/busy-overlay";

import type { CommandesTeleversement, EtatTeleversement } from "./use-televersement";

/**
 * Surcouche d'envoi — la MÊME, d'où que parte le téléversement.
 *
 * Elle ne décide de rien : elle rend l'état du hook. C'est voulu. Si chaque
 * écran composait sa propre surcouche, deux d'entre eux finiraient par ne pas
 * dire la même chose du même transfert — l'un annonçant un pourcentage là où
 * l'autre tournerait dans le vide.
 *
 * Le libellé de reprise n'est personnalisé que pour les fichiers réellement
 * REPRENABLES. Promettre « Reprendre » à un envoi qui recommence de zéro serait
 * un mensonge d'interface, et l'utilisateur le découvrirait au pire moment.
 */
export function SurcoucheTeleversement({
  etat,
}: {
  etat: EtatTeleversement & CommandesTeleversement;
}) {
  return (
    <BusyOverlay
      open={etat.surcouche}
      title={etat.filename ? `Envoi de « ${etat.filename} »` : "Envoi du média"}
      stepLabel={etat.etape}
      progress={etat.progressionAffichable}
      error={etat.error}
      retryLabel={etat.reprenable && etat.phase === "error" ? "Reprendre l'envoi" : undefined}
      onRetry={etat.reprendre}
      onDismiss={etat.fermerSurcouche}
    />
  );
}
