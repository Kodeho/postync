"use client";

import { useActionState, useState } from "react";

import { FormAlert } from "@/components/ui/form-alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { instantToWallClock, wallClockToInstant } from "@/lib/time-zone";
import { broadcastAction } from "@/server/social/actions";
import type { BroadcastTargetOutcome } from "@/server/social/broadcast";
import { IDLE_BROADCAST_ACTION } from "@/server/social/broadcast-state";

/**
 * Publication vers plusieurs réseaux, depuis un seul écran (C11).
 *
 * Le fil conducteur est d'ANNONCER AVANT plutôt que d'échouer après. Un média
 * 16:9 passe sur Instagram et sera refusé par Facebook : l'utilisateur le voit
 * au moment de cocher, avec la raison, et la case reste désactivée. Découvrir
 * l'incompatibilité après l'envoi ne lui apprendrait rien d'utile.
 *
 * Le compte des sélections face au quota restant est affiché en continu, pour
 * la même raison.
 */

export type BroadcastAccount = {
  id: string;
  platform: string;
  platformLabel: string;
  label: string;
  /** Faux si le compte doit être reconnecté ou si le réseau ne publie pas. */
  available: boolean;
  unavailableReason: string | null;
};

export type BroadcastMedia = {
  id: string;
  label: string;
  kind: "reel" | "image";
  /** Compatibilité par compte : `true` si ce média convient à ce réseau. */
  compatibleWith: Record<string, { ok: boolean; reasons: string[] }>;
};

export function BroadcastForm({
  workspaceSlug,
  accounts,
  media,
  remainingThisMonth,
  timeZone,
}: {
  workspaceSlug: string;
  accounts: BroadcastAccount[];
  media: BroadcastMedia[];
  remainingThisMonth: number;
  /** Fuseau du workspace : la référence de TOUTES les heures (C13). */
  timeZone: string;
}) {
  const [state, action] = useActionState(broadcastAction, IDLE_BROADCAST_ACTION);

  const [assetId, setAssetId] = useState<string>(media[0]?.id ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [quand, setQuand] = useState<"maintenant" | "plus-tard">("maintenant");
  const [echeanceLocale, setEcheanceLocale] = useState("");
  const [bornes, setBornes] = useState<{ min: string; max: string } | null>(null);

  const choisi = media.find((m) => m.id === assetId) ?? null;

  // Le champ `datetime-local` ne porte AUCUN fuseau : l'heure saisie est
  // interprétée dans celui du WORKSPACE, la même référence que le calendrier.
  const echeanceIso =
    quand === "plus-tard" && echeanceLocale
      ? (wallClockToInstant(echeanceLocale, timeZone)?.toISOString() ?? "")
      : "";

  function choisirProgrammation() {
    // Dans un gestionnaire d'événement : lire l'heure courante pendant le rendu
    // divergerait entre serveur et navigateur.
    const maintenant = Date.now();
    setBornes({
      min: instantToWallClock(maintenant + 6 * 60_000, timeZone),
      max: instantToWallClock(maintenant + 364 * 24 * 3600_000, timeZone),
    });
    setQuand("plus-tard");
  }

  function basculer(id: string) {
    setSelected((actuels) =>
      actuels.includes(id) ? actuels.filter((x) => x !== id) : [...actuels, id],
    );
  }

  /** Un compte est cochable si le réseau est disponible ET le média convient. */
  function etatDuCompte(compte: BroadcastAccount): { ok: boolean; reason: string | null } {
    if (!compte.available) {
      return { ok: false, reason: compte.unavailableReason };
    }
    if (!choisi) {
      return { ok: false, reason: "Choisissez d'abord un média." };
    }
    const verdict = choisi.compatibleWith[compte.platform];
    if (!verdict || !verdict.ok) {
      return { ok: false, reason: verdict?.reasons.join(" ") ?? "Média non compatible." };
    }
    return { ok: true, reason: null };
  }

  const cochables = accounts.filter((c) => etatDuCompte(c).ok).map((c) => c.id);
  const retenus = selected.filter((id) => cochables.includes(id));
  const tropDeCibles = retenus.length > remainingThisMonth;

  if (media.length === 0) {
    return (
      <p className="text-sm text-muted">
        Importez d&apos;abord un média depuis la Médiathèque : la publication part de là.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      <input type="hidden" name="mediaKind" value={choisi?.kind ?? "reel"} />
      <input type="hidden" name="scheduledAt" value={echeanceIso} />
      {retenus.map((id) => (
        <input key={id} type="hidden" name="socialAccountIds" value={id} />
      ))}

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-foreground">Média</span>
        <select
          name="mediaAssetId"
          value={assetId}
          onChange={(event) => setAssetId(event.target.value)}
          className="rounded-md border border-border bg-surface px-3 py-2 text-foreground shadow-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
        >
          {media.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-foreground">Légende</span>
        <textarea
          name="caption"
          rows={3}
          maxLength={2200}
          placeholder="Facultative — la même légende part sur tous les réseaux sélectionnés."
          className="rounded-md border border-border bg-surface px-3 py-2 text-foreground shadow-soft transition-colors placeholder:text-muted-soft hover:border-border-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
        />
      </label>

      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="font-medium text-foreground">Réseaux</legend>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted">
            Connectez un compte depuis Comptes sociaux pour publier.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {accounts.map((compte) => {
              const etat = etatDuCompte(compte);
              return (
                <li key={compte.id}>
                  <label
                    className={`flex items-start gap-2 rounded-md border border-border p-2.5 ${
                      etat.ok ? "bg-surface" : "bg-surface-muted/60"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      disabled={!etat.ok}
                      checked={selected.includes(compte.id)}
                      onChange={() => basculer(compte.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">
                        {compte.platformLabel} · {compte.label}
                      </span>
                      {/* Dire POURQUOI, plutôt que de griser sans explication. */}
                      {etat.reason ? (
                        <span className="block text-xs text-muted">{etat.reason}</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-1.5 text-sm">
        <legend className="font-medium text-foreground">Quand publier</legend>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="quand"
              checked={quand === "maintenant"}
              onChange={() => setQuand("maintenant")}
            />
            Maintenant
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="quand"
              checked={quand === "plus-tard"}
              onChange={choisirProgrammation}
            />
            Programmer
          </label>
        </div>
      </fieldset>

      {quand === "plus-tard" ? (
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Date et heure</span>
          <input
            type="datetime-local"
            required
            value={echeanceLocale}
            min={bornes?.min}
            max={bornes?.max}
            onChange={(event) => setEcheanceLocale(event.target.value)}
            className="rounded-md border border-border bg-surface px-3 py-2 text-foreground shadow-soft focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/60"
          />
          <span className="text-xs text-muted">
            Heure du workspace ({timeZone.replace(/_/g, " ")}), au moins cinq minutes à
            l&apos;avance.
          </span>
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {retenus.length === 0 || tropDeCibles ? (
          <button
            type="button"
            disabled
            title={
              retenus.length === 0
                ? "Sélectionnez au moins un réseau"
                : `Il ne reste que ${remainingThisMonth} publication(s) ce mois-ci`
            }
            className="inline-flex h-10 cursor-not-allowed items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground opacity-60"
          >
            {quand === "plus-tard" ? "Programmer" : "Publier"}
          </button>
        ) : (
          <SubmitButton
            label={
              quand === "plus-tard"
                ? `Programmer sur ${retenus.length} réseau${retenus.length > 1 ? "x" : ""}`
                : `Publier sur ${retenus.length} réseau${retenus.length > 1 ? "x" : ""}`
            }
            pendingLabel={quand === "plus-tard" ? "Enregistrement…" : "Publication…"}
          />
        )}
        <span className="text-xs text-muted">
          {retenus.length} sélectionné(s) · {remainingThisMonth} publication(s) restante(s) ce
          mois-ci
        </span>
      </div>

      {state.error ? <FormAlert tone="error">{state.error}</FormAlert> : null}

      {state.results ? (
        <ResultatsParReseau results={state.results} accounts={accounts} />
      ) : null}
    </form>
  );
}

/**
 * Résultat réseau par réseau.
 *
 * Rien n'est agrégé en un verdict unique : publier sur trois réseaux dont un
 * refuse ne ressemble ni à une réussite ni à un échec, et prétendre le
 * contraire ferait croire à l'utilisateur que son contenu est en ligne
 * partout. Chaque ligne dit ce qui s'est passé, et le lien mène à la
 * publication réelle quand elle existe.
 */
function ResultatsParReseau({
  results,
  accounts,
}: {
  results: BroadcastTargetOutcome[];
  accounts: BroadcastAccount[];
}) {
  const nom = (id: string) => {
    const compte = accounts.find((c) => c.id === id);
    return compte ? `${compte.platformLabel} · ${compte.label}` : "Compte";
  };

  const echecs = results.filter((r) => r.status === "failed").length;
  const partiel = echecs > 0 && echecs < results.length;

  return (
    <div className="flex flex-col gap-2">
      {partiel ? (
        <FormAlert tone="error">
          Publication partielle : {results.length - echecs} réseau(x) sur {results.length}.
          Le détail est ci-dessous.
        </FormAlert>
      ) : null}

      <ul className="flex flex-col gap-1.5">
        {results.map((resultat) => (
          <li
            key={resultat.socialAccountId}
            className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface p-2.5 text-sm"
          >
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-foreground">
                {nom(resultat.socialAccountId)}
              </span>
              <span
                className={`block text-xs ${
                  resultat.status === "failed" ? "text-danger" : "text-muted"
                }`}
              >
                {LIBELLES[resultat.status]}
                {resultat.code ? ` — ${PUBLISH_HINTS[resultat.code] ?? resultat.code}` : ""}
              </span>
            </span>
            {resultat.permalink ? (
              <a
                href={resultat.permalink}
                target="_blank"
                rel="noreferrer noopener"
                className="shrink-0 text-xs text-primary underline-offset-2 hover:underline"
              >
                Voir
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const LIBELLES: Record<BroadcastTargetOutcome["status"], string> = {
  published: "En ligne.",
  pending: "La plateforme prépare encore le média. La publication reprendra toute seule.",
  scheduled: "Programmée.",
  failed: "Non publiée",
};

/**
 * Les codes les plus courants, traduits. Ceux qui manquent s'affichent tels
 * quels : un code brut reste plus utile qu'un « une erreur est survenue ».
 */
const PUBLISH_HINTS: Record<string, string> = {
  account_inactive: "ce compte doit être reconnecté.",
  missing_scope: "ce compte a été connecté avant l'activation de la publication ; reconnectez-le.",
  media_incompatible: "ce média ne convient pas à ce réseau.",
  media_not_found: "média introuvable ou pas encore prêt.",
  quota_exceeded: "limite de publications du plan atteinte.",
  needs_reconnect: "l'autorisation n'a pas pu être renouvelée ; reconnectez le compte.",
  token_unavailable: "autorisation indisponible ; reconnectez le compte.",
  provider_error: "la plateforme a refusé la publication.",
  container_failed: "la plateforme a rejeté le média.",
  publishing_unavailable: "la publication n'est pas encore disponible pour ce réseau.",
};
