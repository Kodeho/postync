import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { classifyFailure } from "./failure";
import { getUsableAccessToken } from "./token";
import { SocialIdentityUnavailableError, type SocialProvider } from "./providers/types";

/**
 * Rétention et révocation des données de chaîne YouTube (Developer Policies).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUE CE MODULE EXISTE POUR TENIR
 * ─────────────────────────────────────────────────────────────────────────
 *
 * III.E.4.c — l'identité de chaîne (`provider_account_id`, `display_name`,
 * `avatar_url`) est de la donnée autorisée ordinaire : conservable « for no
 * longer than 30 calendar days », après quoi il faut « either delete or
 * refresh ». Elle était lue UNE FOIS à la connexion et jamais relue.
 *
 * III.D.2 — après une révocation faite depuis les paramètres Google, la
 * suppression doit intervenir sous 30 jours, et l'API Client « will need to
 * periodically reconfirm that its authorization tokens are still valid ».
 * Rien ne le faisait : un compte inactif n'était réexaminé qu'à la prochaine
 * publication, c'est-à-dire peut-être jamais.
 *
 * Le délai de 7 jours, lui, concerne les révocations passant par NOTRE
 * mécanisme — le bouton Déconnecter. Il est déjà tenu, et largement :
 * `disconnect_social_account` purge dans la transaction du clic. Ce module ne
 * le remplace pas, il couvre l'angle mort d'à côté.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UNE SEULE OPÉRATION SATISFAIT LES TROIS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Relire l'identité auprès de YouTube exige un jeton valide. La relecture
 * rafraîchit donc la donnée (III.E.4.c) ET reconfirme le jeton (III.D.2) du
 * même geste. Rien ne justifierait deux mécanismes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUI N'EST JAMAIS PURGÉ
 * ─────────────────────────────────────────────────────────────────────────
 *
 * La purge passe par `disconnect_social_account`, la MÊME fonction que le
 * bouton Déconnecter — donc les mêmes garanties, éprouvées : la légende, le
 * média, les dates et le statut des publications sont conservés, seuls les
 * champs venant de la plateforme sont effacés. Les comptes des autres réseaux
 * ne sont même pas lus : la requête filtre sur `platform = 'youtube'`.
 */

/** Au-delà, l'identité est relue. Choisi très en deçà du plafond légal. */
export const IDENTITY_REFRESH_AFTER_DAYS = 7;

/**
 * Plafond des Developer Policies III.E.4.c. Passé ce délai SANS relecture
 * réussie, la donnée doit partir — « delete OR refresh », et si le refresh
 * échoue durablement, il reste delete.
 */
export const IDENTITY_MAX_AGE_DAYS = 30;

const JOUR_MS = 24 * 60 * 60 * 1000;
export const IDENTITY_REFRESH_AFTER_MS = IDENTITY_REFRESH_AFTER_DAYS * JOUR_MS;
export const IDENTITY_MAX_AGE_MS = IDENTITY_MAX_AGE_DAYS * JOUR_MS;

/** Ligne minimale nécessaire à la décision. */
export type RetentionAccount = {
  id: string;
  workspace_id: string;
  platform: string;
  status: string;
  connected_at: string;
  identity_refreshed_at: string | null;
  identity_refresh_failures: number | null;
};

export type RetentionDecision =
  | { action: "keep" }
  | { action: "refresh" }
  | { action: "purge"; reason: "revoked" | "stale" };

/**
 * Faut-il relire, purger, ou laisser tranquille ?
 *
 * Fonction PURE : aucune E/S, aucune horloge implicite. C'est la politique
 * elle-même, et c'est ce que les tests vérifient — le reste n'est que du
 * câblage.
 */
export function decideRetention(compte: RetentionAccount, maintenant: number): RetentionDecision {
  // Une révocation DÉJÀ constatée ailleurs (échec de renouvellement lors d'une
  // publication) attend sa purge : le statut fait foi, on ne redemande rien à
  // la plateforme.
  if (compte.status === "revoked") {
    return { action: "purge", reason: "revoked" };
  }

  // `null` ne peut arriver que sur une ligne créée par du code antérieur à la
  // migration : on se rabat sur la date de connexion, qui EST la date de
  // lecture de l'identité.
  const luLe = Date.parse(compte.identity_refreshed_at ?? compte.connected_at);
  if (Number.isNaN(luLe)) {
    // Date illisible : on relit plutôt que de deviner. Une relecture est sans
    // conséquence ; une purge à tort ne se répare pas.
    return { action: "refresh" };
  }

  const age = maintenant - luLe;
  if (age >= IDENTITY_MAX_AGE_MS) {
    return { action: "purge", reason: "stale" };
  }
  if (age >= IDENTITY_REFRESH_AFTER_MS) {
    return { action: "refresh" };
  }
  return { action: "keep" };
}

export type SuiteEchec =
  | { action: "purge"; reason: "revoked" | "stale" }
  | { action: "retry" };

/**
 * Que faire quand la relecture ÉCHOUE ?
 *
 * LA DISTINCTION EST TOUT. Une plateforme en panne et une autorisation
 * retirée produisent la même chose de notre point de vue — un appel qui
 * échoue — et les confondre coûte cher dans les deux sens : purger sur un
 * 503 détruit un compte valide ; ne jamais purger laisse des données qu'on
 * n'a plus le droit de garder.
 *
 * `classifyFailure` tranche sur des signaux DOCUMENTÉS et non ambigus
 * (`invalid_grant`, `invalid_token`), et teste les signaux passagers AVANT :
 * un 5xx accompagné d'un texte trompeur ne déclasse pas un compte.
 *
 * Un échec passager ne purge donc jamais par lui-même. Il ne purge que si
 * l'identité franchit entre-temps le plafond des 30 jours — auquel cas ce
 * n'est plus une décision sur la révocation, mais l'application de
 * III.E.4.c : la donnée est trop vieille, et faute de pouvoir la rafraîchir,
 * il faut la supprimer.
 */
export function decideAfterFailure(
  detail: string | null | undefined,
  ageIdentiteMs: number,
): SuiteEchec {
  if (classifyFailure(detail) === "auth_revoked") {
    return { action: "purge", reason: "revoked" };
  }
  if (ageIdentiteMs >= IDENTITY_MAX_AGE_MS) {
    return { action: "purge", reason: "stale" };
  }
  return { action: "retry" };
}

export type RetentionDeps = {
  db: SupabaseClient;
  getProvider: (platform: string) => SocialProvider | null;
  now?: () => number;
  /** Taille du lot : une passe courte, répétée, plutôt qu'une interminable. */
  batchSize?: number;
};

export type RetentionOutcome = {
  accountId: string;
  action: "keep" | "refreshed" | "purged" | "retry";
  reason?: "revoked" | "stale";
  detail?: string;
};

export type RetentionReport = {
  examines: number;
  rafraichis: number;
  purges: number;
  reessais: number;
  resultats: RetentionOutcome[];
};

const LOT_DEFAUT = 25;

/**
 * Une passe de rétention. Idempotente : rien ne se produit pour un compte
 * dont l'identité est fraîche, et deux passes rapprochées ne font pas deux
 * fois le travail.
 */
export async function runYouTubeRetention(deps: RetentionDeps): Promise<RetentionReport> {
  const now = deps.now ?? Date.now;
  const maintenant = now();
  const rapport: RetentionReport = { examines: 0, rafraichis: 0, purges: 0, reessais: 0, resultats: [] };

  // FILTRE SUR LA PLATEFORME. Les comptes Instagram, Facebook et TikTok ne
  // sont même pas lus : ces règles sont celles de YouTube, et étendre la
  // purge à d'autres réseaux serait une décision distincte.
  const { data, error } = await deps.db
    .from("social_accounts")
    .select(
      "id, workspace_id, platform, status, connected_at, identity_refreshed_at, identity_refresh_failures",
    )
    .eq("platform", "youtube")
    .in("status", ["active", "expired", "error", "revoked"])
    .order("identity_refreshed_at", { ascending: true, nullsFirst: true })
    .limit(deps.batchSize ?? LOT_DEFAUT);

  if (error) {
    console.error(`[retention] lecture: ${error.code ?? "erreur"}`);
    return rapport;
  }

  for (const compte of (data ?? []) as RetentionAccount[]) {
    rapport.examines += 1;
    const decision = decideRetention(compte, maintenant);

    if (decision.action === "keep") {
      rapport.resultats.push({ accountId: compte.id, action: "keep" });
      continue;
    }

    if (decision.action === "purge") {
      await purger(deps, compte, decision.reason, rapport);
      continue;
    }

    // --- relecture de l'identité ------------------------------------------
    const provider = deps.getProvider(compte.platform);
    if (!provider?.fetchIdentity) {
      // Sans moyen de relire, la seule issue conforme reste la suppression
      // une fois le plafond atteint. `decideRetention` s'en chargera.
      rapport.reessais += 1;
      rapport.resultats.push({ accountId: compte.id, action: "retry", detail: "no_provider" });
      continue;
    }

    const complet = await lireCompteComplet(deps.db, compte.id);
    if (!complet) {
      rapport.resultats.push({ accountId: compte.id, action: "retry", detail: "row_gone" });
      continue;
    }

    const token = await getUsableAccessToken({ db: deps.db, now }, provider, complet);
    if (!token.ok) {
      await suiteEchec(deps, compte, token.code, maintenant, rapport);
      continue;
    }

    try {
      const identite = await provider.fetchIdentity(token.accessToken);
      await deps.db
        .from("social_accounts")
        .update({
          display_name: identite.displayName,
          avatar_url: identite.avatarUrl,
          identity_refreshed_at: new Date(maintenant).toISOString(),
          identity_refresh_failures: 0,
        })
        .eq("id", compte.id);
      rapport.rafraichis += 1;
      rapport.resultats.push({ accountId: compte.id, action: "refreshed" });
    } catch (erreur) {
      // Un compte Google qui n'a plus de chaîne n'est pas une panne : il n'y
      // a plus rien à rafraîchir, et l'identité stockée n'a plus d'objet.
      const detail =
        erreur instanceof SocialIdentityUnavailableError
          ? "identity_unavailable"
          : erreur instanceof Error
            ? erreur.message
            : "erreur";
      await suiteEchec(deps, compte, detail, maintenant, rapport);
    }
  }

  console.info(
    `[retention] examines=${rapport.examines} rafraichis=${rapport.rafraichis} purges=${rapport.purges} reessais=${rapport.reessais}`,
  );
  return rapport;
}

async function suiteEchec(
  deps: RetentionDeps,
  compte: RetentionAccount,
  detail: string,
  maintenant: number,
  rapport: RetentionReport,
): Promise<void> {
  const luLe = Date.parse(compte.identity_refreshed_at ?? compte.connected_at);
  const age = Number.isNaN(luLe) ? 0 : maintenant - luLe;
  const suite = decideAfterFailure(detail, age);

  if (suite.action === "purge") {
    await purger(deps, compte, suite.reason, rapport);
    return;
  }

  // Échec passager : on compte, on ne détruit rien. Le compteur sert au
  // diagnostic ; ce n'est PAS lui qui décide de la purge — seul le plafond
  // des 30 jours le fait, et une révocation confirmée le court-circuite.
  await deps.db
    .from("social_accounts")
    .update({ identity_refresh_failures: (compte.identity_refresh_failures ?? 0) + 1 })
    .eq("id", compte.id);
  rapport.reessais += 1;
  // Jamais le message brut de la plateforme : un code court, comme partout.
  rapport.resultats.push({ accountId: compte.id, action: "retry", detail: "transient" });
}

async function purger(
  deps: RetentionDeps,
  compte: RetentionAccount,
  reason: "revoked" | "stale",
  rapport: RetentionReport,
): Promise<void> {
  // MÊME fonction que le bouton Déconnecter : une seule transaction, les
  // publications en cours annulées, les champs de plateforme effacés, la
  // ligne supprimée et ses secrets détruits par le trigger. Les contenus de
  // l'utilisateur survivent.
  const { error } = await deps.db.rpc("disconnect_social_account", {
    p_account_id: compte.id,
    p_workspace_id: compte.workspace_id,
  });
  if (error) {
    console.error(`[retention] purge ${reason}: ${error.code ?? "erreur"}`);
    rapport.resultats.push({ accountId: compte.id, action: "retry", detail: "purge_failed" });
    return;
  }
  rapport.purges += 1;
  rapport.resultats.push({ accountId: compte.id, action: "purged", reason });
}

async function lireCompteComplet(db: SupabaseClient, id: string) {
  const { data } = await db
    .from("social_accounts")
    .select(
      "id, platform, provider_account_id, access_token_id, refresh_token_id, token_expires_at, scopes, status",
    )
    .eq("id", id)
    .maybeSingle();
  return (data ?? null) as Parameters<typeof getUsableAccessToken>[2] | null;
}
