/** État renvoyé par les Server Actions d'administration. */
export type AdminActionState = {
  ok: boolean;
  message: string | null;
};

export const IDLE_ADMIN_ACTION: AdminActionState = { ok: true, message: null };
