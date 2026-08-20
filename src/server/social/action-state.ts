/** État renvoyé par les Server Actions des comptes sociaux. */
export type SocialActionState = { error: string | null };

export const IDLE_SOCIAL_ACTION: SocialActionState = { error: null };
