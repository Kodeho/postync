-- ===========================================================================
-- POSTYNC — C10.1 : planification des publications
-- ===========================================================================
-- Jusqu'ici une publication partait immédiatement. Planifier suppose trois
-- choses : une échéance, un statut qui la distingue d'une publication en
-- cours, et surtout un moyen de la RÉCLAMER sans risque de double envoi.
--
-- LE POINT CRITIQUE : la réclamation.
--
-- Un planificateur qui publie deux fois le même contenu est pire que pas de
-- planificateur du tout — sur un réseau social, l'erreur est publique et
-- irrattrapable. La réclamation ne peut donc pas être « lire les échéances
-- dues, puis les publier » : deux exécutions concurrentes liraient la même
-- ligne. Elle est une TRANSITION D'ÉTAT atomique, faite par la base :
--
--     update ... set status = 'pending'
--     where status = 'scheduled' and scheduled_at <= now()
--     returning ...
--
-- Postgres garantit qu'une seule transaction verra la ligne passer de
-- `scheduled` à `pending`. Un second réveil du cron, ou un appel concurrent,
-- ne la voit plus. C'est `claim_due_publications()` ci-dessous.
--
-- Le statut réutilisé est `pending`, celui qui existait déjà pour « en cours,
-- reprenable » : une publication réclamée puis interrompue est exactement
-- cela, et le mécanisme de reprise de C8.4b la rattrape sans code nouveau.
--
-- `attempts` évite l'acharnement : une publication qui échoue pour une raison
-- durable ne doit pas être retentée indéfiniment. La colonne n'est PAS
-- accordée au client — elle relève de l'exploitation, pas de l'affichage.
-- ===========================================================================

alter table public.social_publications
  add column if not exists scheduled_at timestamptz,
  add column if not exists attempts smallint not null default 0;

comment on column public.social_publications.scheduled_at is
  'Échéance demandée. Null pour une publication immédiate. Conservée après publication : elle fait partie de l''historique.';
comment on column public.social_publications.attempts is
  'Nombre de tentatives de publication différée. Colonne d''exploitation, volontairement non accordée au client.';

-- Deux statuts nouveaux : en attente d'échéance, et annulée par l'utilisateur.
alter table public.social_publications
  drop constraint if exists social_publications_status_check;
alter table public.social_publications
  add constraint social_publications_status_check
  check (status in ('scheduled', 'pending', 'published', 'failed', 'canceled'));

-- Une publication programmée porte forcément une échéance.
alter table public.social_publications
  drop constraint if exists social_publications_scheduled_shape;
alter table public.social_publications
  add constraint social_publications_scheduled_shape
  check (status <> 'scheduled' or scheduled_at is not null);

-- Balayage des échéances dues : index PARTIEL et non filtré par workspace.
-- Le planificateur interroge la table entière — c'est le seul accès du produit
-- qui ignore délibérément le cloisonnement, parce qu'il n'agit pour personne
-- en particulier. Il tourne en service_role, jamais sous une session.
create index if not exists social_publications_due_idx
  on public.social_publications (scheduled_at)
  where status = 'scheduled';

-- L'échéance est lisible par le workspace : le calendrier en a besoin.
-- `attempts` reste absente de la liste blanche, volontairement.
grant select (scheduled_at) on public.social_publications to authenticated;


-- ---------------------------------------------------------------------------
-- Réclamation atomique des publications dues
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER et réservée à service_role : cette fonction traverse tous
-- les workspaces, elle ne doit jamais être atteignable depuis une session.
--
-- `p_limit` borne le lot : mieux vaut plusieurs passages courts qu'un seul
-- interminable, une fonction serverless ayant une durée maximale.
--
-- `p_max_attempts` : au-delà, la publication est marquée en échec plutôt que
-- reprise sans fin. Elle reste visible, avec sa raison.
-- ---------------------------------------------------------------------------

create or replace function public.claim_due_publications(
  p_limit integer default 10,
  p_max_attempts smallint default 3
)
returns table (id uuid, workspace_id uuid)
language sql
security definer
set search_path = public
as $$
  with dues as (
    -- `attempts` est lu ICI, dans l'instantané verrouillé : les deux
    -- instructions suivantes doivent trancher sur la MÊME valeur, sans quoi
    -- une ligne pourrait échapper aux deux.
    select p.id, p.attempts
    from public.social_publications p
    where p.status = 'scheduled'
      and p.scheduled_at <= now()
    order by p.scheduled_at
    limit greatest(p_limit, 0)
    -- Deux exécutions concurrentes ne se disputent pas les mêmes lignes.
    for update skip locked
  ),
  epuisees as (
    update public.social_publications p
    set status = 'failed',
        status_detail = 'too_many_attempts'
    from dues
    where p.id = dues.id
      and dues.attempts >= p_max_attempts
    returning p.id
  )
  update public.social_publications p
  set status = 'pending',
      attempts = p.attempts + 1
  from dues
  where p.id = dues.id
    and dues.attempts < p_max_attempts
  returning p.id, p.workspace_id;
$$;

revoke all on function public.claim_due_publications(integer, smallint) from public;
revoke all on function public.claim_due_publications(integer, smallint) from anon, authenticated;
grant execute on function public.claim_due_publications(integer, smallint) to service_role;

comment on function public.claim_due_publications(integer, smallint) is
  'Réclame atomiquement les publications dues (scheduled -> pending). Traverse tous les workspaces : service_role uniquement.';
