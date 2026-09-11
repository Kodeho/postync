"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

import { finalizeUploadAction, requestUploadAction } from "@/server/media/actions";
import { IDLE_MEDIA_ACTION, IDLE_UPLOAD_TICKET } from "@/server/media/action-state";
import { ALLOWED_MIME_TYPES, MAX_BYTE_SIZE, formatBytes } from "@/server/media/rules";

import {
  SEUIL_REPRENABLE,
  messageDeRefus,
  televerser,
  type Progression,
  type Ticket,
  type Transfert,
} from "./upload-transport";

/**
 * Téléversement d'un média — LA logique, en un seul endroit.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI UN HOOK PLUTÔT QU'UN COMPOSANT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Deux écrans déclenchent le même envoi : la médiathèque, avec son champ de
 * fichier visible et ses explications, et la vue d'ensemble, avec un simple
 * bouton. Ce ne sont pas les mêmes commandes ; c'est exactement le même
 * parcours.
 *
 * En faire un composant unique aurait obligé à le tordre par des options
 * d'apparence (« mode bouton », « mode champ »), et la tentation aurait été
 * grande, au second écran, de recopier trois lignes « juste pour aller vite ».
 * Le jour où le transport, les contrôles ou les messages changent, un seul des
 * deux chemins serait corrigé — et personne ne s'en apercevrait avant qu'un
 * utilisateur ne perde un fichier.
 *
 * Le hook porte donc TOUT ce qui décide : contrôles de format et de taille,
 * ticket, transport, reprise, phases, messages. Les composants ne portent que
 * ce qui se voit.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QU'IL NE FAIT PAS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Il ajoute le média à la médiathèque, et rien d'autre. Aucune publication,
 * aucune diffusion, aucun réseau contacté : déposer un fichier et le publier
 * sont deux décisions distinctes, et les confondre reviendrait à publier au
 * nom de quelqu'un qui n'a demandé qu'un envoi.
 */

export type Phase = "idle" | "preparing" | "uploading" | "finalizing" | "done" | "error";

/** Libellé de chaque phase. Une seule source, pour la surcouche comme pour l'aria. */
const ETAPES: Record<Phase, string> = {
  idle: "",
  preparing: "Préparation du téléversement…",
  uploading: "Téléversement du fichier",
  finalizing: "Vérification par le serveur…",
  done: "Terminé",
  error: "Échec",
};

export type EtatTeleversement = {
  phase: Phase;
  /** Pourcentage MESURÉ, 0–100. N'a de sens que pendant `uploading`. */
  progress: number;
  /** Octets réellement envoyés, ou `null` hors transfert. */
  octets: Progression | null;
  /** Confirmation après réussite. */
  message: string | null;
  error: string | null;
  filename: string | null;
  /** Une opération est en cours : les commandes doivent se verrouiller. */
  occupe: boolean;
  /** Le dernier fichier passe par le transport reprenable. */
  reprenable: boolean;
  /** Libellé d'étape, enrichi des octets pendant le transfert. */
  etape: string;
  surcouche: boolean;
  /** Progression à passer à la surcouche : un nombre, ou `undefined`. */
  progressionAffichable: number | undefined;
  dernierFichier: File | null;
};

export type CommandesTeleversement = {
  /** Point d'entrée unique : un fichier choisi par l'utilisateur. */
  choisir: (file: File) => void;
  /** Rejoue le dernier fichier. Pour un gros fichier, REPREND où il en était. */
  reprendre: (() => void) | undefined;
  /** Ferme la surcouche après un échec, sans rien réinitialiser. */
  fermerSurcouche: () => void;
  /** Remet tout à zéro et interrompt un transfert en vol. */
  reinitialiser: () => void;
};

export function useTeleversementMedia({
  workspaceSlug,
  onReinitialiser,
}: {
  workspaceSlug: string;
  /** Appelé par `reinitialiser`, pour vider un champ de fichier par exemple. */
  onReinitialiser?: () => void;
}): EtatTeleversement & CommandesTeleversement {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [octets, setOctets] = useState<Progression | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [dernierFichier, setDernierFichier] = useState<File | null>(null);
  const [surcouche, setSurcouche] = useState(false);

  /**
   * Ticket en cours. Dans une ref, pas dans un state : il est lu à l'intérieur
   * d'une fonction asynchrone déjà partie, où un state re-rendu n'arriverait
   * pas à temps.
   */
  const ticketRef = useRef<Ticket | null>(null);
  /** Transfert en vol, pour pouvoir l'interrompre proprement. */
  const transfertRef = useRef<Transfert | null>(null);

  const envoyer = useCallback(
    async (file: File) => {
      setError(null);
      setMessage(null);
      setFilename(file.name);
      setDernierFichier(file);

      // Premier filtre côté navigateur : inutile de déranger le serveur pour un
      // fichier manifestement hors limites. Le serveur revérifie TOUT, car un
      // contrôle de navigateur ne protège de rien.
      //
      // Ces deux refus sont IMMÉDIATS : ils ne passent pas par la surcouche,
      // qui n'a de sens que pour une opération réellement en cours.
      if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
        setPhase("error");
        setError("Format non pris en charge. Vidéos MP4 ou MOV, images JPEG.");
        return;
      }
      if (file.size > MAX_BYTE_SIZE) {
        setPhase("error");
        setError(
          `Ce fichier fait ${formatBytes(file.size)} ; la limite est de ${formatBytes(MAX_BYTE_SIZE)}.`,
        );
        return;
      }

      setSurcouche(true);

      // REPRISE : un ticket déjà obtenu pour CE fichier est réutilisé tel quel.
      // Sans cette branche, chaque tentative repartirait du premier octet et
      // laisserait une réservation orpheline de plus.
      let ticket = ticketRef.current;
      if (!ticket) {
        setPhase("preparing");
        const demande = new FormData();
        demande.set("workspaceSlug", workspaceSlug);
        demande.set("filename", file.name);
        demande.set("mimeType", file.type);
        demande.set("byteSize", String(file.size));

        const reponse = await requestUploadAction(IDLE_UPLOAD_TICKET, demande);
        if (reponse.error || !reponse.ticket) {
          setPhase("error");
          setError(reponse.error ?? "Le téléversement n'a pas pu être préparé.");
          return;
        }
        ticket = reponse.ticket;
        ticketRef.current = ticket;
      }

      setPhase("uploading");
      setProgress(0);
      try {
        const transfert = televerser(ticket, file, (p) => {
          setOctets(p);
          setProgress(p.total > 0 ? Math.round((p.envoyes / p.total) * 100) : 0);
        });
        transfertRef.current = transfert;
        await transfert.termine;
      } catch (erreur) {
        setPhase("error");
        setError(messageDeRefus(erreur));
        return;
      } finally {
        transfertRef.current = null;
      }

      // Le serveur confirme la présence du fichier et le MESURE lui-même.
      setPhase("finalizing");
      const confirmation = new FormData();
      confirmation.set("workspaceSlug", workspaceSlug);
      confirmation.set("assetId", ticket.assetId);
      const finalise = await finalizeUploadAction(IDLE_MEDIA_ACTION, confirmation);

      if (finalise.error) {
        setPhase("error");
        setError(finalise.error);
        return;
      }

      // Réussi : le ticket est consommé, plus rien à reprendre.
      ticketRef.current = null;
      setPhase("done");
      setSurcouche(false);
      setMessage(finalise.notice);
      onReinitialiser?.();
      // La médiathèque est rafraîchie même quand l'envoi part d'un autre écran :
      // le média doit y apparaître sans que l'utilisateur ait à recharger.
      router.refresh();
    },
    [workspaceSlug, onReinitialiser, router],
  );

  /** Un NOUVEAU fichier invalide le ticket : on ne reprend pas un autre envoi. */
  const choisir = useCallback(
    (file: File) => {
      if (ticketRef.current && dernierFichier !== file) {
        ticketRef.current = null;
      }
      void envoyer(file);
    },
    [envoyer, dernierFichier],
  );

  const reinitialiser = useCallback(() => {
    transfertRef.current?.interrompre();
    transfertRef.current = null;
    ticketRef.current = null;
    setPhase("idle");
    setProgress(0);
    setOctets(null);
    setError(null);
    setMessage(null);
    setSurcouche(false);
    onReinitialiser?.();
  }, [onReinitialiser]);

  const occupe = phase === "preparing" || phase === "uploading" || phase === "finalizing";
  const reprenable = (dernierFichier?.size ?? 0) > SEUIL_REPRENABLE;

  return {
    phase,
    progress,
    octets,
    message,
    error,
    filename,
    occupe,
    reprenable,
    dernierFichier,
    surcouche,
    // Le pourcentage n'est transmis QUE pendant le transfert des octets : c'est
    // la seule phase mesurée. Ailleurs, la barre doit rester indéterminée
    // plutôt que d'inventer une avancée.
    progressionAffichable: phase === "uploading" ? progress : undefined,
    etape:
      phase === "uploading" && octets
        ? `${ETAPES.uploading} — ${formatBytes(octets.envoyes)} sur ${formatBytes(octets.total)}`
        : ETAPES[phase],
    choisir,
    reprendre: dernierFichier ? () => void envoyer(dernierFichier) : undefined,
    fermerSurcouche: () => setSurcouche(false),
    reinitialiser,
  };
}
