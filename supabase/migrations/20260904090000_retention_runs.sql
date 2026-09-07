-- Journal des passes de rétention YouTube — le signal de SURVEILLANCE.
--
-- POURQUOI UNE TABLE. La passe est réveillée par pg_cron via pg_net : son
-- rapport JSON atterrit dans net._http_response, purgé en quelques heures, et
-- sa ligne de log vit dans les logs Vercel, conservés quelques jours. Aucun
-- des deux n'est un signal durable ni commodément consultable. Or les deux
-- dérives que la passe peut connaître — une SATURATION (budget épuisé avant
-- la file, les identités vieillissent en silence) et une SÉRIE D'ÉCHECS —
-- ne se voient que dans la durée : il faut pouvoir les lire d'une requête
-- SQL, des semaines plus tard.
--
-- UNE LIGNE PAR INVOCATION, écrite par la route (service_role), succès comme
-- échec. Compteurs et booléens uniquement : aucun identifiant de compte,
-- aucun nom, aucun jeton. Le détail PAR COMPTE se lit dans social_accounts
-- (status, status_detail, identity_refresh_failures), qui reste la source de
-- vérité — ce journal dit qu'il faut aller regarder, pas quoi regarder.
--
-- COMPTEURS NULLABLES, ET LA NUANCE EST LE POINT. `0` est une MESURE : la
-- passe a tourné et n'a rien eu à faire. `null` veut dire INCONNU : une
-- invocation a échoué en vol, son rapport est perdu, et des opérations
-- partielles ont pu avoir lieu sans être comptées. Écrire 0 dans ce cas
-- présenterait une absence de mesure comme une mesure.
--
-- CE QUE CE JOURNAL NE PEUT PAS DIRE : qu'aucune passe n'a eu lieu — un
-- timeout qui tue l'invocation avant l'écriture ne laisse AUCUNE ligne. La
-- détection d'absence est donc une REQUÊTE (silence > 26 h), croisée avec
-- cron.job_run_details ; voir docs/VALIDATION_PR9_RETENTION.md §3.

create table if not exists public.retention_runs (
  id                  bigint      generated always as identity primary key,
  ran_at              timestamptz not null default now(),
  examined            integer,
  refreshed           integer,
  purged              integer,
  retried             integer,
  publications_purged integer,
  batches             integer,
  saturated           boolean,
  duration_ms         integer,
  -- Vocabulaire FERMÉ, identique à CODES_ERREUR de retention-journal.ts :
  -- jamais un message brut — un message inattendu pourrait charrier une
  -- donnée sensible, un code choisi dans une liste ne le peut pas.
  error_code          text,

  constraint retention_runs_error_code_controle
    check (
      error_code is null
      or error_code in ('vault_error', 'provider_error', 'network_error', 'db_error', 'unknown_error')
    )
);

comment on table public.retention_runs is
  'Journal des passes de rétention YouTube : une ligne par invocation, compteurs seulement. NULL = inconnu (échec en vol), 0 = mesuré.';
comment on column public.retention_runs.saturated is
  'Budget épuisé avant la fin de la file : des comptes attendent. Doit rester false ; NULL = invocation échouée, mesure perdue.';
comment on column public.retention_runs.error_code is
  'Code d''échec d''invocation, vocabulaire fermé (voir CHECK). NULL = invocation aboutie.';

-- La surveillance lit « les derniers jours », toujours par ran_at.
create index if not exists retention_runs_ran_at_idx
  on public.retention_runs (ran_at desc);

-- Table interne : écrite et lue par service_role uniquement. RLS activée sans
-- politique et droits révoqués — même fermeture que les autres tables
-- internes du dépôt.
alter table public.retention_runs enable row level security;
revoke all on table public.retention_runs from anon, authenticated;
