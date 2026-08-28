/**
 * États des formulaires de réglages (C13).
 *
 * Dans un module à part : un fichier `"use server"` ne peut exporter que des
 * fonctions asynchrones, et une constante y provoque une erreur qui ne se
 * manifeste qu'au premier appel réel — ni le build ni les tests ne l'attrapent.
 * Le piège avait déjà coûté une mise en production en C9.
 */
export type SettingsFormState = {
  error: string | null;
  /** Message de confirmation, affiché sur place après un enregistrement. */
  notice: string | null;
};

export const IDLE_SETTINGS_FORM: SettingsFormState = { error: null, notice: null };
