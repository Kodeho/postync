-- ===========================================================================
-- POSTYNC — C10.1 : rattacher une publication au mois où elle a LIEU
-- ===========================================================================
-- Le quota du plan s'appelle `publicationsPerMonth`. Tant que tout partait
-- immédiatement, compter sur `created_at` disait la même chose que compter
-- sur la date de publication. La planification sépare les deux : une
-- publication créée le 31 janvier pour le 3 février aurait consommé le quota
-- de janvier tout en paraissant en février.
--
-- `coalesce(scheduled_at, created_at)` porte sur deux colonnes STOCKÉES et
-- reste donc immuable : la colonne peut être GÉNÉRÉE. Postgres la calcule,
-- aucun code applicatif ne peut la désynchroniser — le même raisonnement que
-- `social_accounts.can_refresh` en C8.5.
-- ===========================================================================

alter table public.social_publications
  add column if not exists effective_at timestamptz
  generated always as (coalesce(scheduled_at, created_at)) stored;

comment on column public.social_publications.effective_at is
  'Date à laquelle la publication se rattache : son échéance si elle est programmée, sa création sinon. Sert au quota mensuel du plan.';

-- Le comptage du quota et l'affichage du calendrier lisent tous deux par
-- workspace puis par cette date.
create index if not exists social_publications_workspace_effective_idx
  on public.social_publications (workspace_id, effective_at desc);

grant select (effective_at) on public.social_publications to authenticated;
