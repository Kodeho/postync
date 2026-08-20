import { createHash, randomBytes } from "node:crypto";

/**
 * Primitives OAuth pures (state + PKCE RFC 7636) — testables sans réseau.
 *
 * Le `state` envoyé au provider est une valeur aléatoire opaque ; seule son
 * empreinte SHA-256 est stockée en base (un dump d'`oauth_states` ne permet
 * pas de forger un callback). Le `code_verifier` est stocké dans Vault.
 */

/** Valeur aléatoire URL-safe de 256 bits. */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/** Empreinte hexadécimale stockée dans `oauth_states.state_hash`. */
export function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/** RFC 7636 §4.1 — verifier de 43 à 128 caractères non réservés. */
export function generateCodeVerifier(): string {
  return randomBytes(48).toString("base64url"); // 64 caractères
}

/** RFC 7636 §4.2 — challenge S256 : BASE64URL(SHA256(ASCII(verifier))). */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
