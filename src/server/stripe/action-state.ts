/** État renvoyé par les Server Actions de facturation. */
export type BillingActionState = { error: string | null };

export const IDLE_BILLING_ACTION: BillingActionState = { error: null };
