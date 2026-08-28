-- ===========================================================================
-- POSTYNC — C10.2 : secret du planificateur et reprise des publications
-- ===========================================================================
--
-- LE SECRET. La route `/api/cron/publish` déclenche des publications : elle
-- ne peut pas être ouverte. Le secret partagé vit dans Vault, et les DEUX
-- extrémités l'y lisent — le job pg_cron via `vault.decrypted_secrets`,
-- l'application via `scheduler_secret()`, réservée à service_role.
--
-- Il est GÉNÉRÉ EN BASE, par `gen_random_bytes`. Sa valeur ne transite donc
-- par aucun fichier, aucune console, aucune variable d'environnement à
-- déployer : il n'existe qu'à l'intérieur de Postgres et en mémoire serveur
-- le temps d'une comparaison.
--
-- L'URL du site est rangée au même endroit. Ce n'est pas un secret, mais
-- Vault est le magasin clé/valeur que le job sait lire — c'est le motif
-- retenu par la documentation Supabase elle-même pour `project_url`.
-- ===========================================================================

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'scheduler/cron') then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'scheduler/cron',
      'Secret partage entre pg_cron et la route /api/cron/publish'
    );
  end if;

  if not exists (select 1 from vault.secrets where name = 'scheduler/site_url') then
    perform vault.create_secret(
      'https://postync.vercel.app',
      'scheduler/site_url',
      'Origine appelee par le planificateur'
    );
  end if;
end
$$;

create or replace function public.scheduler_secret()
returns text
language sql
security definer
set search_path = public
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'scheduler/cron' limit 1;
$$;

revoke all on function public.scheduler_secret() from public;
revoke all on function public.scheduler_secret() from anon, authenticated;
grant execute on function public.scheduler_secret() to service_role;

comment on function public.scheduler_secret() is
  'Secret partage du planificateur. service_role uniquement : jamais atteignable depuis une session.';


-- ---------------------------------------------------------------------------
-- Reprise des publications restées en cours
-- ---------------------------------------------------------------------------
-- Une publication dont le conteneur n'est pas prêt dans le budget d'attente
-- reste `pending`. Jusqu'ici, seule l'interface pouvait la reprendre : cela
-- revenait à espérer qu'un humain regarde à 3 h du matin. Sans cette reprise
-- automatique, la planification serait un piège.
--
-- La reprise doit être EXCLUSIVE au même titre que la réclamation : deux
-- réveils qui reprendraient le même conteneur pourraient le publier deux
-- fois. L'exclusion repose sur `updated_at`, que le trigger
-- `social_publications_set_updated_at` remet à `now()` à CHAQUE écriture. Le
-- code applicatif ne peut donc pas la falsifier — c'est précisément ce qu'on
-- attend d'un verrou. La ligne réclamée sort de la fenêtre de sélection pour
-- `p_stale_after`.
--
-- `p_max_attempts` est plus large qu'à la réclamation initiale : une reprise
-- est bon marché (on interroge un conteneur, on ne renvoie jamais le média),
-- et un transcodage lent mérite plusieurs passages.
-- ---------------------------------------------------------------------------

drop function if exists public.claim_stale_publications(integer, interval, smallint);

create function public.claim_stale_publications(
  p_limit integer default 5,
  p_stale_after interval default interval '3 minutes',
  p_max_attempts smallint default 10
)
returns table (id uuid, workspace_id uuid, container_id text)
language sql
security definer
set search_path = public
as $$
  update public.social_publications p
  set attempts = p.attempts + 1
  from (
    select s.id
    from public.social_publications s
    -- PAS de condition sur `container_id`. Une exécution morte entre la
    -- réclamation et la création du conteneur laissait sinon la publication
    -- `pending` sans conteneur, donc hors d'atteinte de toute reprise : perdue
    -- pour toujours. Le planificateur sait rattraper les deux cas.
    where s.status = 'pending'
      and s.attempts < p_max_attempts
      and s.updated_at < now() - p_stale_after
    order by s.updated_at
    limit greatest(p_limit, 0)
    for update skip locked
  ) d
  where p.id = d.id
  returning p.id, p.workspace_id, p.container_id;
$$;

revoke all on function public.claim_stale_publications(integer, interval, smallint) from public;
revoke all on function public.claim_stale_publications(integer, interval, smallint) from anon, authenticated;
grant execute on function public.claim_stale_publications(integer, interval, smallint) to service_role;

comment on function public.claim_stale_publications(integer, interval, smallint) is
  'Reclame les publications restees en cours, AVEC ou SANS conteneur. Exclusive via updated_at. service_role uniquement.';
