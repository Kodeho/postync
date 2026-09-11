"use client";

import * as tus from "tus-js-client";

import { createClient } from "@/lib/supabase/client";
import { requireSupabaseEnv } from "@/lib/supabase/env";

/**
 * Transport des octets vers Supabase Storage.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEUX CHEMINS, ET LA RAISON DE CHACUN
 * ─────────────────────────────────────────────────────────────────────────
 *
 * PETIT FICHIER (≤ 6 Mo) — `PUT` sur une URL signée. Une seule requête, pas
 * de JWT, pas de RLS : le serveur a déjà tout vérifié en signant. Ajouter un
 * protocole reprenable à un transfert d'une seconde n'apporterait rien.
 *
 * GROSSE VIDÉO (> 6 Mo) — protocole TUS. Le fichier part par tranches de
 * 6 Mo ; une coupure ne coûte que la tranche en cours, et la reprise repart
 * de l'octet suivant, sans jamais dupliquer l'objet. C'est aussi ce qui rend
 * les nouvelles tentatives automatiques : `retryDelays` rejoue la tranche
 * échouée sans que l'utilisateur ait quoi que ce soit à faire.
 *
 * TUS N'ACCEPTE PAS D'URL SIGNÉE. Son endpoint s'authentifie avec le JWT de
 * l'utilisateur et passe par RLS — d'où la politique `media_resumable_insert`
 * (migration 20260911120000), qui n'ouvre QUE l'insertion, et seulement dans
 * le dossier du workspace. Le jeton employé ici est le jeton de session du
 * navigateur : la clé `service_role` n'apparaît nulle part dans ce module, ni
 * dans aucun module qu'il importe.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LA PROGRESSION EST MESURÉE, JAMAIS SIMULÉE
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Les deux chemins rapportent des OCTETS RÉELLEMENT ENVOYÉS, fournis par le
 * navigateur. Aucune interpolation, aucune barre qui avance toute seule.
 */

/** Imposé par Supabase : la taille de tranche TUS doit valoir exactement 6 Mo. */
const TAILLE_TRANCHE = 6 * 1024 * 1024;

/**
 * Au-delà, on passe en reprenable. Le seuil est celui de la tranche : en
 * dessous, TUS enverrait de toute façon une seule tranche, sans bénéfice.
 */
export const SEUIL_REPRENABLE = TAILLE_TRANCHE;

export type Progression = {
  /** Octets confirmés par le navigateur. */
  envoyes: number;
  total: number;
};

export type Ticket = {
  assetId: string;
  storagePath: string;
  uploadUrl: string;
};

/** Une opération en cours, qu'on peut interrompre. */
export type Transfert = {
  termine: Promise<void>;
  /**
   * Interrompt le transfert. Pour TUS, l'interruption est PROPRE : le serveur
   * garde les octets déjà reçus, et un appel ultérieur avec le même ticket
   * reprend là où on s'est arrêté.
   */
  interrompre: () => void;
};

/**
 * Erreur de transport porteuse du VRAI message du stockage.
 *
 * Le motif de ce type : la version précédente avalait la réponse et affichait
 * « Le transfert a échoué. Réessayez. » pour tout. Un refus de taille et une
 * coupure de câble devenaient indiscernables, et un fichier refusé par la
 * limite du projet invitait à retenter indéfiniment.
 */
export class ErreurTransport extends Error {
  readonly statut: number | null;
  /** Corps brut renvoyé par le stockage, tronqué. Sert au diagnostic. */
  readonly corps: string;

  constructor(message: string, statut: number | null, corps: string) {
    super(message);
    this.name = "ErreurTransport";
    this.statut = statut;
    this.corps = corps.slice(0, 500);
  }
}

/**
 * Traduit un refus du stockage en phrase compréhensible.
 *
 * Le cas qui motive tout : un projet Supabase porte une limite GLOBALE de
 * taille de fichier, distincte de celle du bucket, et c'est la plus BASSE qui
 * s'applique. Un bucket réglé à 300 Mo dans un projet plafonné à 50 Mo refuse
 * donc à 50 Mo — avec un message que personne ne lisait jusqu'ici.
 */
export function messageDeRefus(erreur: unknown): string {
  if (!(erreur instanceof ErreurTransport)) {
    return "Le transfert du fichier a échoué. Vérifiez votre connexion, puis réessayez.";
  }

  const corps = erreur.corps.toLowerCase();
  const tropGros =
    erreur.statut === 413 ||
    corps.includes("maximum allowed size") ||
    corps.includes("payload too large") ||
    corps.includes("entity too large");

  if (tropGros) {
    const taille = tailleMaximaleAnnoncee(erreur.corps);
    return taille
      ? `Le stockage a refusé ce fichier : il dépasse la taille maximale autorisée par le projet (${taille}). ` +
          "Cette limite est celle du projet Supabase, pas celle de POSTYNC ; un administrateur doit la relever."
      : "Le stockage a refusé ce fichier car il dépasse la taille maximale autorisée par le projet. " +
          "Cette limite est celle du projet Supabase, pas celle de POSTYNC ; un administrateur doit la relever.";
  }

  // 401 et 403 ne disent PAS la même chose, et les confondre a coûté une
  // enquête entière : un 403 avait été lu comme « reconnectez-vous » alors que
  // la session était parfaitement valide et que c'était la politique RLS qui
  // manquait côté base.
  if (erreur.statut === 401) {
    // Le jeton est absent, invalide ou expiré. Se reconnecter a un sens.
    return "Votre session a expiré. Reconnectez-vous, puis réessayez.";
  }
  if (erreur.statut === 403) {
    // Le jeton est VALIDE — le stockage l'a accepté — mais la règle d'accès
    // refuse l'écriture. Se reconnecter n'y changerait rien.
    return (
      "Le stockage a bien reconnu votre session mais refuse l'écriture dans ce dossier. " +
      "C'est une règle d'accès du projet Supabase, pas un problème de connexion : " +
      "se reconnecter n'y changera rien. Signalez cette erreur à un administrateur."
    );
  }
  if (erreur.statut === 409) {
    return "Ce téléversement a déjà abouti. Rafraîchissez la médiathèque.";
  }
  if (erreur.statut === null) {
    return "La connexion a été interrompue pendant le transfert. Réessayez : l'envoi reprendra où il s'est arrêté.";
  }
  return `Le stockage a répondu ${erreur.statut}. Réessayez ; si le problème persiste, signalez ce code.`;
}

/** Extrait « 50 MB » d'un message du type « exceeded the maximum allowed size of 52428800 bytes ». */
function tailleMaximaleAnnoncee(corps: string): string | null {
  const octets = /(\d{6,})\s*bytes/i.exec(corps);
  if (!octets) return null;
  const valeur = Number(octets[1]);
  if (!Number.isFinite(valeur) || valeur <= 0) return null;
  const mo = valeur / (1024 * 1024);
  return mo >= 1 ? `${Math.round(mo)} Mo` : `${Math.round(valeur / 1024)} Ko`;
}

/**
 * Choisit le transport et lance l'envoi.
 *
 * `ticket` doit être le MÊME objet d'un essai à l'autre pour qu'une reprise
 * soit possible : c'est lui qui porte le chemin de destination. Redemander un
 * ticket produirait un nouveau chemin, donc un nouvel envoi depuis zéro.
 */
export function televerser(
  ticket: Ticket,
  file: File,
  onProgress: (p: Progression) => void,
): Transfert {
  return file.size > SEUIL_REPRENABLE
    ? televerserReprenable(ticket, file, onProgress)
    : televerserSimple(ticket, file, onProgress);
}

/** `PUT` unique sur l'URL signée. Pour les petits fichiers. */
function televerserSimple(
  ticket: Ticket,
  file: File,
  onProgress: (p: Progression) => void,
): Transfert {
  const xhr = new XMLHttpRequest();
  const termine = new Promise<void>((resolve, reject) => {
    xhr.open("PUT", ticket.uploadUrl, true);
    xhr.setRequestHeader("content-type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress({ envoyes: event.loaded, total: event.total });
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress({ envoyes: file.size, total: file.size });
        resolve();
        return;
      }
      // Le corps est LU, et non jeté : c'est lui qui porte le motif réel.
      reject(new ErreurTransport(`HTTP ${xhr.status}`, xhr.status, xhr.responseText ?? ""));
    };
    xhr.onerror = () => reject(new ErreurTransport("réseau", null, ""));
    xhr.onabort = () => reject(new ErreurTransport("interrompu", null, "aborted"));
    xhr.send(file);
  });

  return { termine, interrompre: () => xhr.abort() };
}

/** Envoi par tranches de 6 Mo, reprenable. Pour les vidéos. */
function televerserReprenable(
  ticket: Ticket,
  file: File,
  onProgress: (p: Progression) => void,
): Transfert {
  let upload: tus.Upload | null = null;
  let interrompu = false;

  const termine = (async () => {
    const { url, anonKey } = requireSupabaseEnv();
    const supabase = createClient();

    /**
     * Jeton d'accès FRAIS, redemandé à chaque requête.
     *
     * `getSession` renouvelle le jeton de lui-même s'il est expiré ou sur le
     * point de l'être. C'est précisément pourquoi il est appelé ICI plutôt
     * qu'une fois au démarrage : un jeton Supabase vit une heure, un envoi de
     * 300 Mo sur une ligne lente peut durer davantage, et une reprise le
     * lendemain repartirait avec un jeton mort. Un en-tête figé au démarrage
     * condamnerait donc exactement les transferts que le mode reprenable est
     * censé sauver.
     *
     * `getSession` est le bon appel : aucune décision d'autorisation n'est
     * prise ici à partir de la session. On transmet le jeton brut au stockage,
     * qui le valide lui-même.
     */
    const jetonFrais = async (): Promise<string> => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const jeton = session?.access_token;
      if (!jeton) {
        throw new ErreurTransport("session absente", 401, "no session");
      }
      return jeton;
    };

    // Vérifié AVANT de créer le transfert : inutile d'ouvrir un envoi qui
    // échouera à la première requête.
    await jetonFrais();

    await new Promise<void>((resolve, reject) => {
      upload = new tus.Upload(file, {
        endpoint: `${hoteDeStockage(url)}/storage/v1/upload/resumable`,
        // Rejeux automatiques d'une tranche échouée, en espaçant. C'est ce qui
        // absorbe un tunnel, un changement de Wi-Fi, un pic de latence.
        retryDelays: [0, 3000, 5000, 10000, 20000],
        headers: {
          apikey: anonKey,
        },
        // L'autorisation n'est PAS dans `headers` : elle est posée requête par
        // requête ci-dessous, pour qu'une reprise n'emporte jamais un jeton
        // périmé — y compris celui mémorisé lors d'une tentative précédente.
        onBeforeRequest: async (req) => {
          req.setHeader("authorization", `Bearer ${await jetonFrais()}`);
        },
        // Rejouer un refus de RÈGLE ou de TAILLE ne sert à rien : le serveur
        // répondra la même chose cinq fois, et l'utilisateur attendra pour
        // rien. On ne rejoue que ce qui peut changer entre deux essais.
        onShouldRetry: (error) => {
          const statut = (error as tus.DetailedError).originalResponse?.getStatus?.() ?? 0;
          if (statut === 403 || statut === 413 || statut === 400) return false;
          return true;
        },
        uploadDataDuringCreation: true,
        // L'empreinte est effacée à la réussite : sans cela, renvoyer plus tard
        // le même fichier ferait croire à une reprise d'un transfert terminé.
        removeFingerprintOnSuccess: true,
        metadata: {
          bucketName: "media",
          objectName: ticket.storagePath,
          contentType: file.type,
        },
        chunkSize: TAILLE_TRANCHE,
        onError: (error) => {
          const reponse = (error as tus.DetailedError).originalResponse;
          const statut = reponse?.getStatus?.() ?? null;
          const corps = reponse?.getBody?.() ?? "";
          reject(new ErreurTransport(error.message, statut || null, corps));
        },
        onProgress: (envoyes, total) => onProgress({ envoyes, total }),
        onSuccess: () => resolve(),
      });

      // Reprise : si une tentative précédente a laissé une URL d'envoi pour ce
      // même fichier ET ce même chemin, on repart de l'octet suivant.
      void upload
        .findPreviousUploads()
        .then((precedents) => {
          if (interrompu) return;
          if (precedents.length > 0) {
            upload?.resumeFromPreviousUpload(precedents[0]);
          }
          upload?.start();
        })
        .catch(() => {
          // Le registre local est inaccessible (navigation privée, quota) :
          // ce n'est pas une raison de renoncer, on part de zéro.
          if (!interrompu) upload?.start();
        });
    });
  })();

  return {
    termine,
    interrompre: () => {
      interrompu = true;
      // `false` : on NE supprime PAS le transfert côté serveur, justement pour
      // pouvoir le reprendre.
      void upload?.abort(false);
    },
  };
}

/**
 * Hôte de stockage direct.
 *
 * Supabase recommande `https://<ref>.storage.supabase.co` plutôt que l'hôte
 * d'API pour les gros fichiers : le chemin est plus court et évite un étage
 * de routage. Si l'URL du projet n'a pas cette forme (domaine personnalisé,
 * instance auto-hébergée), on garde l'hôte tel quel — mieux vaut un transfert
 * un peu moins direct qu'une URL inventée.
 */
export function hoteDeStockage(urlProjet: string): string {
  const sansSlash = urlProjet.replace(/\/+$/, "");
  const correspondance = /^https:\/\/([a-z0-9-]+)\.supabase\.co$/i.exec(sansSlash);
  return correspondance ? `https://${correspondance[1]}.storage.supabase.co` : sansSlash;
}
