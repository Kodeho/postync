import { PRODUCT_NAME } from "@/config/product";
import { WORKSPACE_ROLE_LABELS } from "@/features/workspaces/display";
import type { WorkspaceRole } from "@/types/workspace-role";

import { renderEmail, renderText, type EmailBlock } from "./layout";

/**
 * Invitation à rejoindre un workspace (C14).
 *
 * CE QUE CE MESSAGE DOIT FAIRE COMPRENDRE EN TROIS SECONDES : qui invite, à
 * quoi, et que le lien ne vaut que pour l'adresse à laquelle il est arrivé.
 * Ce dernier point n'est pas une précaution rhétorique — c'est la règle de
 * sécurité de C14, et la dire évite qu'on transfère le message à un collègue
 * en s'étonnant ensuite que cela ne fonctionne pas.
 *
 * Le nom de l'invitant est facultatif : POSTYNC connaît son adresse, pas
 * toujours son nom affiché. Mieux vaut une phrase impersonnelle qu'un
 * « invité par null ».
 */

export type InvitationEmailInput = {
  workspaceName: string;
  role: WorkspaceRole | string;
  invitationUrl: string;
  /** Nom de la personne qui invite, si POSTYNC le connaît. */
  invitedByName?: string | null;
  /** Échéance de l'invitation, pour dire l'urgence sans l'inventer. */
  expiresAt: string;
};

function libelleRole(role: string): string {
  return WORKSPACE_ROLE_LABELS[role as WorkspaceRole] ?? role;
}

function jourEnFrancais(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function buildInvitationEmail(input: InvitationEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const title = `Rejoindre « ${input.workspaceName} » sur ${PRODUCT_NAME}`;

  const ouverture = input.invitedByName
    ? `${input.invitedByName} vous invite à rejoindre l'espace de travail « ${input.workspaceName} » sur ${PRODUCT_NAME}.`
    : `Vous êtes invité à rejoindre l'espace de travail « ${input.workspaceName} » sur ${PRODUCT_NAME}.`;

  const blocks: EmailBlock[] = [
    { kind: "paragraph", text: ouverture },
    {
      kind: "paragraph",
      text: `Votre rôle y sera : ${libelleRole(input.role)}. ${PRODUCT_NAME} permet de publier une même vidéo sur plusieurs réseaux sociaux, en une seule fois.`,
    },
    { kind: "button", label: "Accepter l'invitation", href: input.invitationUrl },
    { kind: "fallback-link", href: input.invitationUrl },
    {
      kind: "note",
      text: `Ce lien ne fonctionne que depuis l'adresse à laquelle cet e-mail a été envoyé, et expire le ${jourEnFrancais(input.expiresAt)}. Si vous n'avez pas encore de compte ${PRODUCT_NAME}, créez-le avec cette même adresse : l'invitation vous attendra.`,
    },
  ];

  return {
    subject: `Invitation à rejoindre « ${input.workspaceName} » sur ${PRODUCT_NAME}`,
    html: renderEmail({ title, blocks }),
    text: renderText({ title, blocks }),
  };
}
