import { PRODUCT_NAME } from "@/config/product";

import { renderEmail, renderText, type EmailBlock } from "./layout";

/**
 * Notifications de sécurité.
 *
 * À QUOI SERT CE MESSAGE. Prévenir d'un changement de mot de passe n'informe
 * pas celui qui l'a fait — il le sait. Il informe celui qui NE l'a PAS fait.
 * C'est souvent le seul signal qu'une personne reçoit lorsqu'un tiers a pris
 * la main sur son compte, et le seul moment où elle peut encore réagir.
 *
 * Le message ne contient donc aucun lien d'action : ni « ce n'était pas moi »
 * cliquable, ni jeton. Un courriel d'alerte porteur d'un lien est exactement
 * ce que reproduisent les tentatives d'hameçonnage, et POSTYNC ne peut pas
 * apprendre à ses clients à cliquer dans ce genre de message. On indique quoi
 * faire, l'utilisateur se rend lui-même sur le service.
 */

export type PasswordChangedInput = {
  /** `reset` : via un lien reçu. `settings` : depuis les paramètres. */
  origin: "reset" | "settings";
  /** Fuseau du workspace, pour dater l'événement de façon compréhensible. */
  occurredAtIso: string;
  timeZone: string;
};

function dateLisible(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone,
  });
}

export function buildPasswordChangedEmail(input: PasswordChangedInput): {
  subject: string;
  html: string;
  text: string;
} {
  const title = "Votre mot de passe a été modifié";

  const comment =
    input.origin === "reset"
      ? "à partir d'un lien de réinitialisation"
      : "depuis les paramètres de votre compte";

  const blocks: EmailBlock[] = [
    {
      kind: "paragraph",
      text: `Le mot de passe de votre compte ${PRODUCT_NAME} a été modifié ${comment}, le ${dateLisible(input.occurredAtIso, input.timeZone)}.`,
    },
    {
      kind: "paragraph",
      text: "Vos autres sessions ouvertes ont été fermées : il faudra vous reconnecter sur vos autres appareils.",
    },
    {
      kind: "paragraph",
      text: "Si vous êtes à l'origine de ce changement, il n'y a rien à faire.",
    },
    {
      kind: "note",
      text: `Dans le cas contraire, connectez-vous sans tarder à ${PRODUCT_NAME} et changez à nouveau votre mot de passe. Par précaution, nous ne mettons aucun lien d'action dans ce message : rendez-vous sur le site par vos propres moyens, comme vous le feriez d'habitude.`,
    },
  ];

  return {
    subject: `${PRODUCT_NAME} — votre mot de passe a été modifié`,
    html: renderEmail({ title, blocks }),
    text: renderText({ title, blocks }),
  };
}
