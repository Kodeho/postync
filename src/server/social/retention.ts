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

/**
 * Deux passes ne doivent pas se disputer le même compte.
 *
 * Le planificateur de publication se protège par une réclamation atomique en
 * base ; ici l'enjeu est moindre — au pire deux relectures, donc du quota
 * dépensé pour rien — mais deux passes simultanées doubleraient les appels
 * distants. Espacer les tentatives d'une heure suffit, et se lit dans une
 * colonne plutôt que dans un verrou.
 */
export const MIN_ATTEMPT_INTERVAL_MS = 60 * 60 * 1000;

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
  /** Dernière TENTATIVE. Ne participe jamais au calcul de la rétention. */
  identity_attempted_at: string | null;
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
  // la plateforme. Cette purge n'est PAS espacée — il n'y a plus rien à
  // ménager, et le délai réglementaire court déjà.
  if (compte.status === "revoked") {
    return { action: "purge", reason: "revoked" };
  }

  // Tentative trop récente : une autre passe s'en occupe, ou vient de le
  // faire. On ne redouble pas les appels distants.
  const tenteLe = compte.identity_attempted_at ? Date.parse(compte.identity_attempted_at) : null;
  if (tenteLe !== null && !Number.isNaN(tenteLe) && maintenant - tenteLe < MIN_ATTEMPT_INTERVAL_MS) {
    return { action: "keep" };
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
  // AU-DELÀ DU PLAFOND, ON ESSAIE ENCORE — on ne purge pas d'emblée.
  //
  // « Delete OR refresh » : le refresh satisfait l'obligation, et une
  // identité de 31 jours qui se relit sans problème n'a aucune raison d'être
  // détruite. Purger sur le seul critère de l'âge ferait pire : un retard de
  // NOTRE passe — saturation, panne du cron — provoquerait une perte de
  // données que rien dans la réglementation n'exige.
  //
  // La purge pour ancienneté n'existe donc que dans `decideAfterFailure` :
  // il faut avoir essayé ET échoué.
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
  /** Taille d'un lot. La passe en enchaîne plusieurs. */
  batchSize?: number;
  /** Budget d'une invocation, en millisecondes. */
  budgetMs?: number;
  /** Horloge de mesure du budget, injectable pour les tests. */
  monotonic?: () => number;
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
  /** Publications dont les identifiants de plateforme ont été effacés. */
  publicationsPurgees: number;
  /** Lots réellement traités pendant cette invocation. */
  lots: number;
  /**
   * Vrai si le budget a été épuisé alors qu'il restait du travail.
   *
   * C'est le signal qui compte : sans lui, une saturation serait invisible
   * et les comptes non traités vieilliraient en silence.
   */
  sature: boolean;
  resultats: RetentionOutcome[];
};

/**
 * Efface les identifiants venus de YouTube dans les publications passées.
 *
 * CE QUE LA CARTE DU COMPTE NE COUVRE PAS. `social_publications` conserve
 * quatre champs issus de la plateforme, indépendamment du compte :
 *
 *   `provider_account_id` — identifiant de la chaîne ;
 *   `provider_media_id`   — identifiant de la vidéo ;
 *   `permalink`           — son URL ;
 *   `container_id`        — l'URI de session d'envoi résumable.
 *
 * Ils relèvent du même plafond de 30 jours (III.E.4.c) et n'étaient effacés
 * qu'à la déconnexion du compte. Une publication d'un compte toujours
 * connecté les gardait indéfiniment.
 *
 * L'échéance se compte depuis `platform_data_at`, l'instant d'ACQUISITION —
 * jamais depuis `updated_at`, qu'une écriture sans rapport avec YouTube
 * remonterait, repoussant artificiellement la purge.
 *
 * CE QUI SURVIT, et c'est le point : la légende, le média, la plateforme, les
 * dates et le statut. Ils viennent de l'utilisateur ou de nous, pas de
 * YouTube. L'historique garde son sens — « une vidéo est partie sur YouTube
 * tel jour » — sans porter la moindre donnée de la plateforme. C'est
 * exactement la sémantique de `disconnect_social_account`, appliquée cette
 * fois au temps plutôt qu'à la déconnexion.
 */
export async function purgeStalePublications(
  deps: RetentionDeps,
  maintenant: number,
): Promise<number> {
  const limite = new Date(maintenant - IDENTITY_MAX_AGE_MS).toISOString();
  const { data, error } = await deps.db
    .from("social_publications")
    .update({
      provider_account_id: null,
      provider_media_id: null,
      permalink: null,
      container_id: null,
      purged_at: new Date(maintenant).toISOString(),
    })
    .eq("platform", "youtube")
    // STATUTS TERMINAUX SEULEMENT. `scheduled` et `pending` sont en vol, et
    // `container_id` y porte l'URI de la session d'envoi résumable :
    // l'effacer ferait rouvrir une session au prochain réveil du
    // planificateur, donc CRÉER UNE SECONDE VIDÉO. Le tableau des statuts ne
    // comporte pas de `processing` — c'est `pending` qui joue ce rôle.
    .in("status", TERMINAUX)
    .is("purged_at", null)
    // `platform_data_at` : l'instant où la donnée a été OBTENUE.
    //
    // Ni `created_at`, qui peut précéder l'envoi de 364 jours et purgerait
    // une donnée obtenue la veille. Ni `updated_at`, qu'un trigger remonte à
    // chaque écriture : une correction de légende repousserait l'échéance des
    // 30 jours, et la donnée serait conservée au-delà de ce que III.E.4.c
    // autorise. Cette colonne-ci n'est écrite qu'aux deux sites
    // d'acquisition, et rien d'autre n'y touche.
    .not("platform_data_at", "is", null)
    .lt("platform_data_at", limite)
    .select("id");

  if (error) {
    console.error(`[retention] purge publications: ${error.code ?? "erreur"}`);
    return 0;
  }
  return (data ?? []).length;
}

const LOT_DEFAUT = 25;

/**
 * Statuts au-delà desquels une publication ne bouge plus.
 *
 * `scheduled` et `pending` en sont volontairement absents : voir
 * `purgeStalePublications`.
 */
export const TERMINAUX = ["published", "failed", "canceled"] as const;

/**
 * Budget d'une invocation. La route déclare `maxDuration = 120` s ; on rend
 * la main avant, pour que le rapport soit émis plutôt que tronqué par le
 * temps mort.
 */
export const PASS_BUDGET_MS = 90_000;

/** Garde-fou de boucle : au pire, on s'arrête et la passe suivante reprend. */
export const MAX_LOTS = 20;

/**
 * Une passe de rétention. Idempotente : rien ne se produit pour un compte
 * dont l'identité est fraîche, et deux passes rapprochées ne font pas deux
 * fois le travail.
 */
export async function runYouTubeRetention(deps: RetentionDeps): Promise<RetentionReport> {
  const now = deps.now ?? Date.now;
  const horloge = deps.monotonic ?? Date.now;
  const debut = horloge();
  const budget = deps.budgetMs ?? PASS_BUDGET_MS;
  const taille = deps.batchSize ?? LOT_DEFAUT;
  const maintenant = now();
  const rapport: RetentionReport = {
    examines: 0, rafraichis: 0, purges: 0, reessais: 0, publicationsPurgees: 0,
    lots: 0, sature: false, resultats: [],
  };

  // PLUSIEURS LOTS PAR INVOCATION.
  //
  // Un seul lot de 25 par jour plafonnait le service à 175 comptes : au-delà,
  // la file s'allongeait, les identités vieillissaient, et la passe finissait
  // par détruire des comptes que rien n'obligeait à détruire. La boucle
  // enchaîne donc les lots tant qu'il reste du travail et du temps.
  //
  // `sature` dit franchement quand le budget s'épuise avant la file. C'est
  // préférable à une file qui s'allonge sans que personne ne le voie.
  for (let lot = 0; lot < MAX_LOTS; lot += 1) {
    if (horloge() - debut >= budget) {
      rapport.sature = true;
      break;
    }
    const traites = await traiterUnLot(deps, rapport, maintenant, now, taille);
    if (traites === 0) break;
    rapport.lots += 1;
    // Un lot plein signifie qu'il reste probablement des lignes derrière.
    if (traites < taille) break;
    if (lot === MAX_LOTS - 1) rapport.sature = true;
  }

  // Indépendant des comptes : une publication vieillit même si son compte est
  // toujours connecté et sa carte fraîchement relue.
  rapport.publicationsPurgees = await purgeStalePublications(deps, maintenant);

  console.info(
    `[retention] lots=${rapport.lots} examines=${rapport.examines} ` +
      `rafraichis=${rapport.rafraichis} purges=${rapport.purges} ` +
      `reessais=${rapport.reessais} publications=${rapport.publicationsPurgees} ` +
      `sature=${rapport.sature}`,
  );
  return rapport;
}

/** Un lot. Rend le nombre de lignes lues — 0 signifie « plus rien à faire ». */
async function traiterUnLot(
  deps: RetentionDeps,
  rapport: RetentionReport,
  maintenant: number,
  now: () => number,
  taille: number,
): Promise<number> {
  // FILTRE SUR LA PLATEFORME. Les comptes Instagram, Facebook et TikTok ne
  // sont même pas lus : ces règles sont celles de YouTube, et étendre la
  // purge à d'autres réseaux serait une décision distincte.
  const { data, error } = await deps.db
    .from("social_accounts")
    .select(
      "id, workspace_id, platform, status, connected_at, identity_refreshed_at, " +
        "identity_attempted_at, identity_refresh_failures",
    )
    .eq("platform", "youtube")
    .in("status", ["active", "expired", "error", "revoked"])
    // ORDRE PAR TENTATIVE, pas par réussite. Ordonner par
    // `identity_refreshed_at` ramènerait à chaque passe le compte qui échoue
    // le plus, et les autres ne seraient jamais examinés.
    .order("identity_attempted_at", { ascending: true, nullsFirst: true })
    .limit(taille);

  if (error) {
    console.error(`[retention] lecture: ${error.code ?? "erreur"}`);
    return 0;
  }
  const lignes = (data ?? []) as unknown as RetentionAccount[];

  for (const compte of lignes) {
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

    // RENOUVELLEMENT FORCÉ. Un access token encore valide ne prouve rien sur
    // le refresh token, et c'est celui-ci que III.D.2 demande de reconfirmer.
    // Sans ce forçage, une révocation faite chez Google ne serait décelée
    // qu'au 401 de `channels.list` — dont le code (`authError`) n'est pas un
    // signal documenté, donc classé « passager », donc purgé seulement au
    // plafond des 30 jours. L'échange du refresh token, lui, rend un
    // `invalid_grant` sans ambiguïté.
    await deps.db
      .from("social_accounts")
      .update({ identity_attempted_at: new Date(maintenant).toISOString() })
      .eq("id", compte.id);

    const token = await getUsableAccessToken({ db: deps.db, now }, provider, complet, {
      forceRefresh: true,
    });
    if (!token.ok) {
      // `getUsableAccessToken` ne rend qu'un code générique — `needs_reconnect`
      // aussi bien pour une révocation que pour une panne. Le VERDICT, lui,
      // est déjà écrit dans la ligne : ce module classe l'échec et pose
      // `status = 'revoked'` avec `status_detail = 'refresh_revoked'`.
      //
      // On relit donc la ligne plutôt que de reclasser un message qu'on n'a
      // plus. Dupliquer la classification ici la ferait diverger.
      const apres = await relireStatut(deps.db, compte.id);
      const detail =
        apres?.status === "revoked" ? "invalid_grant" : (apres?.status_detail ?? token.code);
      await suiteEchec(deps, compte, detail, maintenant, rapport);
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

  return lignes.length;
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

/** Statut tel que `getUsableAccessToken` vient éventuellement de l'écrire. */
async function relireStatut(
  db: SupabaseClient,
  id: string,
): Promise<{ status: string; status_detail: string | null } | null> {
  const { data } = await db
    .from("social_accounts")
    .select("status, status_detail")
    .eq("id", id)
    .maybeSingle();
  return (data ?? null) as { status: string; status_detail: string | null } | null;
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
