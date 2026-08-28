import type { BroadcastTargetOutcome } from "./broadcast";

/**
 * État renvoyé par la diffusion multi-réseaux (C11).
 *
 * Vit dans son propre module, hors du fichier `"use server"` : un module de
 * Server Actions ne peut exporter que des fonctions asynchrones, et une
 * constante y provoque une erreur qui ne se manifeste qu'au premier appel
 * réel — ni le build ni les tests ne l'attrapent. Le même piège avait coûté
 * une mise en production en C9.
 */
export type BroadcastActionState = {
  error: string | null;
  /** Résultat réseau par réseau : un échec partiel doit rester visible. */
  results: BroadcastTargetOutcome[] | null;
};

export const IDLE_BROADCAST_ACTION: BroadcastActionState = {
  error: null,
  results: null,
};
