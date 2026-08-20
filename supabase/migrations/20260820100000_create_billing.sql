-- ===========================================================================
-- POSTYNC — C7 : facturation Stripe (billing_customers, subscriptions,
--                subscription_events)
-- ===========================================================================
-- Stripe est la source de vérité du PAIEMENT ; POSTYNC reste la source de
-- vérité de l'identité, des workspaces, des memberships, des platform_role
-- et des entitlements Kodeho. Un abonnement est rattaché au WORKSPACE.
--
-- Écritures : exclusivement côté serveur (webhook Stripe et Server Actions),
-- via le client service_role — jamais depuis le navigateur. Aucune politique
-- RLS d'écriture n'existe donc sur ces tables.
--
-- Les migrations C3/C4/C6 ne sont pas modifiées.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. billing_customers — mapping workspace <-> Stripe Customer
-- ---------------------------------------------------------------------------

create table if not exists public.billing_customers (
  id                  uuid        primary key default gen_random_uuid(),
  workspace_id        uuid        not null unique references public.workspaces (id) on delete cascade,
  stripe_customer_id  text        not null unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint billing_customers_stripe_id_format
    check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$')
);

comment on table public.billing_customers is
  'Un workspace = un Stripe Customer principal. Écrit uniquement côté serveur.';

drop trigger if exists billing_customers_set_updated_at on public.billing_customers;
create trigger billing_customers_set_updated_at
  before update on public.billing_customers
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 2. subscriptions — abonnement courant d'un workspace
-- ---------------------------------------------------------------------------
-- Une ligne par abonnement Stripe. Un workspace n'a qu'un abonnement « vivant »
-- à la fois (index partiel) mais peut conserver des abonnements terminés.

create table if not exists public.subscriptions (
  id                       uuid        primary key default gen_random_uuid(),
  workspace_id             uuid        not null references public.workspaces (id) on delete cascade,
  stripe_subscription_id   text        not null unique,
  stripe_customer_id       text        not null,
  stripe_price_id          text        not null,
  plan_key                 text        not null,
  billing_interval         text        not null,
  status                   text        not null,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean     not null default false,
  canceled_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- Aligné sur src/config/plans.ts ; `unknown` couvre un Price ID Stripe
  -- non reconnu par la configuration (jamais bloquant côté webhook).
  constraint subscriptions_plan_key_check
    check (plan_key in ('free', 'creator', 'pro', 'agency', 'unknown')),
  constraint subscriptions_interval_check
    check (billing_interval in ('month', 'year', 'unknown')),
  -- Statuts Stripe supportés.
  constraint subscriptions_status_check
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'unpaid',
                      'incomplete', 'incomplete_expired', 'paused')),
  constraint subscriptions_stripe_sub_format
    check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$')
);

create index if not exists subscriptions_workspace_id_idx
  on public.subscriptions (workspace_id);
create index if not exists subscriptions_status_idx
  on public.subscriptions (status);

-- Au plus un abonnement « vivant » par workspace.
create unique index if not exists subscriptions_live_per_workspace_idx
  on public.subscriptions (workspace_id)
  where status in ('trialing', 'active', 'past_due', 'unpaid', 'paused', 'incomplete');

comment on table public.subscriptions is
  'Réplique locale des abonnements Stripe (source de vérité : Stripe, synchronisée par webhook).';

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 3. subscription_events — idempotence des webhooks
-- ---------------------------------------------------------------------------
-- Trace technique des événements Stripe déjà traités. `stripe_event_id` est
-- unique : un événement rejoué est ignoré. `payload_metadata` ne contient que
-- des identifiants et statuts (jamais le payload complet ni de donnée carte).

create table if not exists public.subscription_events (
  id                uuid        primary key default gen_random_uuid(),
  stripe_event_id   text        not null unique,
  event_type        text        not null,
  processed_at      timestamptz not null default now(),
  payload_metadata  jsonb       not null default '{}'::jsonb,

  constraint subscription_events_stripe_id_format
    check (stripe_event_id ~ '^evt_[A-Za-z0-9]+$')
);

create index if not exists subscription_events_processed_at_idx
  on public.subscription_events (processed_at desc);

comment on table public.subscription_events is
  'Événements Stripe traités (idempotence). Identifiants et statuts uniquement, jamais de payload sensible.';


-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
-- Lecture : membres du workspace (page billing) et personnel plateforme.
-- subscription_events : admin/super_admin uniquement (donnée technique).
-- Aucune politique d'écriture : le webhook et les Server Actions passent par
-- le client service_role, strictement côté serveur.

alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.subscription_events enable row level security;

drop policy if exists billing_customers_select on public.billing_customers;
create policy billing_customers_select
  on public.billing_customers for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_staff());

drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select
  on public.subscriptions for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_staff());

drop policy if exists subscription_events_select_admin on public.subscription_events;
create policy subscription_events_select_admin
  on public.subscription_events for select to authenticated
  using (coalesce(public.current_platform_role() in ('admin', 'super_admin'), false));

revoke all on public.billing_customers from anon, authenticated;
grant select on public.billing_customers to authenticated;

revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;

revoke all on public.subscription_events from anon, authenticated;
grant select on public.subscription_events to authenticated;


-- ---------------------------------------------------------------------------
-- 5. Lectures d'administration
-- ---------------------------------------------------------------------------

create or replace function public.admin_list_subscriptions(
  p_limit  integer default 50,
  p_offset integer default 0
)
returns table (
  id                     uuid,
  workspace_id           uuid,
  workspace_name         text,
  workspace_slug         text,
  owner_email            text,
  plan_key               text,
  billing_interval       text,
  status                 text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean,
  full_access            boolean,
  created_at             timestamptz,
  total_count            bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select public.assert_platform_role(array['support', 'admin', 'super_admin']);
  select s.id, s.workspace_id, w.name, w.slug, u.email::text,
         s.plan_key, s.billing_interval, s.status,
         s.current_period_end, s.cancel_at_period_end,
         public.workspace_has_full_access(s.workspace_id),
         s.created_at,
         count(*) over () as total_count
  from public.subscriptions s
  join public.workspaces w on w.id = s.workspace_id
  join auth.users u on u.id = w.owner_id
  order by s.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- Compteurs de facturation pour le dashboard. Le MRR est calculé côté
-- application (règle documentée dans docs/BILLING.md) à partir des lignes
-- active/trialing renvoyées par admin_billing_stats.
create or replace function public.admin_billing_stats()
returns table (
  plan_key         text,
  billing_interval text,
  status           text,
  cnt              bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select public.assert_platform_role(array['support', 'admin', 'super_admin']);
  select s.plan_key, s.billing_interval, s.status, count(*)
  from public.subscriptions s
  group by s.plan_key, s.billing_interval, s.status;
$$;

revoke all on function public.admin_list_subscriptions(integer, integer) from public, anon, authenticated;
revoke all on function public.admin_billing_stats()                      from public, anon, authenticated;
grant execute on function public.admin_list_subscriptions(integer, integer) to authenticated;
grant execute on function public.admin_billing_stats()                      to authenticated;
