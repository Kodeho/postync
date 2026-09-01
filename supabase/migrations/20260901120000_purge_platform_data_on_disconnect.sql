-- Purge des données de plateforme à la déconnexion d'un compte social.
--
-- CE QUE CETTE MIGRATION CORRIGE. Jusqu'ici, supprimer un compte social se
-- contentait de passer `social_publications.social_account_id` à null. La ligne
-- SURVIVAIT avec `provider_account_id` (l'identifiant de la chaîne),
-- `provider_media_id` (l'identifiant de la vidéo), `permalink` (son lien) et
-- `container_id` (chez YouTube, l'URI de session résumable). Ce sont des
-- données issues de l'API de la plateforme, ou directement dérivées.
--
-- Les YouTube API Services Terms of Service exigent la suppression des données
-- autorisées lorsque l'utilisateur révoque l'accès. Les conserver — même à
-- titre d'historique — est incompatible avec cette exigence. Meta et TikTok
-- posent des règles équivalentes : la purge est donc appliquée à TOUTE
-- plateforme, et non au seul YouTube. Une asymétrie serait indéfendable.
--
-- CE QUI RESTE. Ce que l'utilisateur a lui-même fourni ou ce qui nous est
-- propre : date, statut, légende, référence du média local, réseau. L'historique
-- garde donc son sens — « une vidéo est partie sur YouTube tel jour » — sans
-- porter la moindre donnée de la plateforme.

-- ---------------------------------------------------------------------------
-- 1. Rendre la purge POSSIBLE
-- ---------------------------------------------------------------------------

-- `provider_account_id` était `not null` : impossible de l'effacer.
alter table public.social_publications
  alter column provider_account_id drop not null;

-- Trace de la purge. Sert de preuve de conformité, et conditionne la contrainte
-- ci-dessous : sans elle, on ne saurait pas distinguer « purgée » de « jamais
-- renseignée », et l'invariant serait perdu pour tout le monde.
alter table public.social_publications
  add column if not exists purged_at timestamptz;

comment on column public.social_publications.purged_at is
  'Instant de la purge des données de plateforme, à la déconnexion du compte. Null = jamais purgée.';

-- L'invariant « une publication aboutie porte son identifiant distant » RESTE
-- vrai pour toute ligne vivante. Il est simplement levé pour une ligne purgée,
-- où l'absence d'identifiant est le résultat recherché et non une anomalie.
alter table public.social_publications
  drop constraint if exists social_publications_published_shape;
alter table public.social_publications
  add constraint social_publications_published_shape
  check (
    status <> 'published'
    or purged_at is not null
    or (provider_media_id is not null and published_at is not null)
  );

-- ---------------------------------------------------------------------------
-- 2. Déconnexion ATOMIQUE
-- ---------------------------------------------------------------------------
--
-- Les trois opérations tiennent dans UNE fonction, donc dans UNE transaction.
-- Enchaînées côté application, une panne entre deux laisserait un état
-- partiellement purgé : compte supprimé mais identifiants de vidéos encore en
-- base, ou l'inverse. C'est précisément l'état qu'aucune politique ne permet
-- d'expliquer.
create or replace function public.disconnect_social_account(
  p_account_id   uuid,
  p_workspace_id uuid
)
returns table (cancelled integer, purged integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cancelled integer := 0;
  v_purged    integer := 0;
begin
  -- a. Ce qui était en cours ne repartira jamais : le jeton n'existera plus.
  --    Sans ce marquage, la ligne resterait `pending` et le planificateur la
  --    réclamerait en boucle, pour échouer à chaque fois faute de compte.
  update public.social_publications
     set status = 'failed',
         status_detail = 'account_disconnected'
   where social_account_id = p_account_id
     and workspace_id = p_workspace_id
     and status in ('pending', 'scheduled');
  get diagnostics v_cancelled = row_count;

  -- b. Purge des données issues de la plateforme. `caption`, `media_url`,
  --    `media_kind`, `platform`, les dates et le statut sont conservés : ils
  --    viennent de l'utilisateur ou de nous.
  update public.social_publications
     set provider_account_id = null,
         provider_media_id   = null,
         permalink           = null,
         container_id        = null,
         purged_at           = now()
   where social_account_id = p_account_id
     and workspace_id = p_workspace_id;
  get diagnostics v_purged = row_count;

  -- c. Suppression du compte. Le trigger `social_accounts_purge_secrets`
  --    détruit les secrets du coffre dans la MÊME transaction.
  delete from public.social_accounts
   where id = p_account_id
     and workspace_id = p_workspace_id;

  return query select v_cancelled, v_purged;
end;
$$;

revoke all on function public.disconnect_social_account(uuid, uuid) from public;
revoke all on function public.disconnect_social_account(uuid, uuid) from anon, authenticated;
grant execute on function public.disconnect_social_account(uuid, uuid) to service_role;

comment on function public.disconnect_social_account(uuid, uuid) is
  'Déconnexion atomique : annule les publications en cours, purge les données de plateforme, supprime le compte (et ses secrets). service_role uniquement.';
