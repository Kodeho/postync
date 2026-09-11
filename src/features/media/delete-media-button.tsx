"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { deleteMediaAction } from "@/server/media/actions";
import { IDLE_MEDIA_ACTION } from "@/server/media/action-state";

/**
 * Suppression d'un média, derrière une confirmation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUE LA BOÎTE ANNONCE EST CE QUE LE CODE FAIT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Le texte ci-dessous n'est pas une formule prudente : il décrit la portée
 * RÉELLE, vérifiée en base le 2026-09-11.
 *
 *   · `deleteAsset` retire l'OBJET du bucket, puis la ligne `media_assets`.
 *     Le fichier stocké disparaît donc vraiment — c'est irréversible ;
 *   · la clé étrangère `social_publications.media_asset_id` est déclarée
 *     `ON DELETE SET NULL` (migration `20260827200000`). Les publications ne
 *     sont PAS supprimées : seul leur lien vers le média se dénoue. Légende,
 *     dates, statut et permalien restent ;
 *   · une vidéo déjà en ligne sur un réseau n'est évidemment pas touchée :
 *     elle vit chez la plateforme, pas chez nous.
 *
 * LE CAS QU'IL FAUT DIRE. Une publication PROGRAMMÉE qui utilise ce média
 * échouera : au réveil du planificateur, le fichier n'existera plus. Le taire
 * serait le plus coûteux des silences — l'utilisateur découvrirait la panne
 * des jours plus tard, sans pouvoir la relier à ce clic.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DOUBLE CLIC
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Deux verrous, parce qu'un seul ne suffit pas : `enCours` bloque l'entrée de
 * `confirmer` même si deux événements arrivent dans le même tick, et la boîte
 * désactive ses deux boutons pendant l'opération. Le premier protège la
 * logique, le second protège l'affichage.
 */
export function DeleteMediaButton({
  workspaceSlug,
  assetId,
  filename,
}: {
  workspaceSlug: string;
  assetId: string;
  filename: string;
}) {
  const router = useRouter();
  const [ouvert, setOuvert] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [succes, setSucces] = useState<string | null>(null);

  async function confirmer() {
    // Garde de réentrance : un second clic pendant l'appel ne relance rien.
    if (enCours) return;
    setEnCours(true);
    setErreur(null);

    const donnees = new FormData();
    donnees.set("workspaceSlug", workspaceSlug);
    donnees.set("assetId", assetId);

    try {
      const resultat = await deleteMediaAction(IDLE_MEDIA_ACTION, donnees);
      if (resultat.error) {
        // La boîte RESTE ouverte : le bouton devient « Réessayer ».
        setErreur(resultat.error);
        return;
      }
      setSucces(resultat.notice ?? "Média supprimé.");
    } catch {
      setErreur("La suppression n'a pas abouti. Vérifiez votre connexion et réessayez.");
    } finally {
      setEnCours(false);
    }
  }

  function fermer() {
    // Pendant l'opération, rien ne ferme — ni Échap, ni clic à côté, ni bouton.
    if (enCours) return;
    const avaitReussi = succes !== null;
    setOuvert(false);
    setErreur(null);
    setSucces(null);
    // Le rafraîchissement n'a lieu QU'APRÈS la fermeture. S'il partait dès le
    // succès, la ligne disparaîtrait, ce composant serait démonté, et la boîte
    // de confirmation avec lui — l'utilisateur ne verrait jamais le message.
    if (avaitReussi) router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOuvert(true)}
        // Le nom du fichier est dans le libellé accessible : sans lui, une
        // page de dix médias offrirait dix boutons « Supprimer » identiques.
        aria-label={`Supprimer « ${filename} »`}
      >
        Supprimer
      </Button>

      <ConfirmDialog
        open={ouvert}
        title="Supprimer cette vidéo ?"
        subject={filename}
        confirmLabel="Supprimer définitivement"
        pendingLabel="Suppression…"
        pending={enCours}
        error={erreur}
        success={succes}
        onConfirm={confirmer}
        onCancel={fermer}
      >
        <p>
          Le fichier sera <strong className="font-medium text-foreground">définitivement
          supprimé</strong> du stockage et retiré de votre médiathèque. Cette action est
          irréversible.
        </p>
        <p>
          Vos publications déjà parues ne sont pas touchées : elles restent dans votre
          historique, et les vidéos en ligne sur vos réseaux le restent aussi.
        </p>
        <p>
          En revanche, une publication <strong className="font-medium text-foreground">programmée
          </strong> qui utilise ce média échouera, son fichier n&apos;existant plus.
        </p>
      </ConfirmDialog>
    </div>
  );
}
