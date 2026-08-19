-- ===========================================================================
-- POSTYNC — C6 : administration Kodeho
-- ===========================================================================
-- Apporte :
--   * profiles.account_status (active | suspended | disabled) ;
--   * workspace_entitlements (Full Access commercial, hors Stripe) ;
--   * admin_audit_logs ;
--   * fonctions d'autorisation plateforme (platform_role) ;
--   * RPC d'administration `security definer` qui vérifient TOUJOURS le
--     platform_role de auth.uid() avant d'agir et journalisent chaque action
--     sensible ;
--   * politiques RLS de LECTURE pour le personnel plateforme.
--
-- Principes :
--   * platform_role (profiles) et rôle workspace (workspace_members) sont
--     indépendants : aucun rôle workspace n'ouvre l'administration ;
--   * la clé service_role n'est jamais nécessaire à l'application : toute
--     opération admin passe par ces RPC, avec le JWT de l'administrateur ;
--   * un compte suspendu perd tout pouvoir, y compris administratif ;
--   * les migrations C3/C4 ne sont pas modifiées.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. profiles.account_status
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists account_status text not null default 'active';

alter table public.profiles
  drop constraint if exists profiles_account_status_check;
alter table public.profiles
  add constraint profiles_account_status_check
    check (account_status in ('active', 'suspended', 'disabled'));

comment on column public.profiles.account_status is
  'active : accès normal ; suspended / disabled : aucun accès à POSTYNC. Modifiable uniquement par les RPC admin.';

-- `authenticated` ne dispose que de update (display_name, avatar_url) depuis
-- C3 : account_status et platform_role restent hors de portée par l'API REST.


-- ---------------------------------------------------------------------------
-- 2. Rôle plateforme de l'appelant
-- ---------------------------------------------------------------------------
-- Un membre du personnel suspendu n'a plus aucun pouvoir : la fonction renvoie
-- alors null.

create or replace function public.current_platform_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.platform_role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.account_status = 'active';
$$;

create or replace function public.is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_platform_role() in ('support', 'admin', 'super_admin'), false);
$$;

-- Lève insufficient_privilege si le rôle courant n'est pas dans la liste.
create or replace function public.assert_platform_role(p_allowed text[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := public.current_platform_role();
begin
  if v_role is null or not (v_role = any (p_allowed)) then
    raise exception 'Accès administrateur refusé.'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. Table workspace_entitlements (droit commercial par workspace)
-- ---------------------------------------------------------------------------
-- Une ligne par workspace = son droit courant. L'historique est porté par
-- admin_audit_logs. Stripe alimentera plus tard le même modèle.

create table if not exists public.workspace_entitlements (
  id            uuid        primary key default gen_random_uuid(),
  workspace_id  uuid        not null unique references public.workspaces (id) on delete cascade,
  access_mode   text        not null default 'standard',
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz,
  reason        text,
  granted_by    uuid        references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint workspace_entitlements_access_mode_check
    check (access_mode in ('standard', 'full_access')),
  constraint workspace_entitlements_period_check
    check (ends_at is null or ends_at > starts_at),
  constraint workspace_entitlements_reason_length
    check (reason is null or char_length(reason) <= 500)
);

comment on table public.workspace_entitlements is
  'Droit commercial courant d''un workspace (standard | full_access), indépendant de Stripe.';

drop trigger if exists workspace_entitlements_set_updated_at on public.workspace_entitlements;
create trigger workspace_entitlements_set_updated_at
  before update on public.workspace_entitlements
  for each row
  execute function public.set_updated_at();

-- Full Access effectif = full_access et non expiré.
create or replace function public.workspace_has_full_access(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_entitlements e
    where e.workspace_id = p_workspace_id
      and e.access_mode = 'full_access'
      and e.starts_at <= now()
      and (e.ends_at is null or e.ends_at > now())
  );
$$;


-- ---------------------------------------------------------------------------
-- 4. Table admin_audit_logs
-- ---------------------------------------------------------------------------

create table if not exists public.admin_audit_logs (
  id             uuid        primary key default gen_random_uuid(),
  actor_user_id  uuid        references auth.users (id) on delete set null,
  action         text        not null,
  target_type    text        not null,
  target_id      text,
  metadata       jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),

  constraint admin_audit_logs_action_format
    check (action ~ '^[a-z_]+\.[a-z_]+$')
);

create index if not exists admin_audit_logs_created_at_idx
  on public.admin_audit_logs (created_at desc);
create index if not exists admin_audit_logs_target_idx
  on public.admin_audit_logs (target_type, target_id);

comment on table public.admin_audit_logs is
  'Journal des actions d''administration. Jamais de secret, jeton, mot de passe ni session dans metadata.';

-- Écriture interne uniquement (depuis les RPC admin).
create or replace function public.admin_audit(
  p_actor uuid,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.admin_audit_logs (actor_user_id, action, target_type, target_id, metadata)
  values (p_actor, p_action, p_target_type, p_target_id, coalesce(p_metadata, '{}'::jsonb));
$$;


-- ---------------------------------------------------------------------------
-- 5. RPC d'administration — ÉCRITURES
-- ---------------------------------------------------------------------------
-- Matrice :
--   support      : lecture seule ;
--   admin        : suspendre/réactiver (hors super_admin), rôles
--                  user/support/admin (hors super_admin, jamais soi-même),
--                  Full Access, audit ;
--   super_admin  : tout, y compris attribuer/retirer super_admin, avec
--                  protection du dernier super_admin.

-- 5a. Statut de compte
create or replace function public.admin_set_account_status(p_user_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := (select auth.uid());
  v_actor_role  text := public.current_platform_role();
  v_target_role text;
  v_old_status  text;
begin
  perform public.assert_platform_role(array['admin', 'super_admin']);

  if p_status not in ('active', 'suspended') then
    raise exception 'Statut invalide.' using errcode = 'invalid_parameter_value';
  end if;

  if p_user_id = v_actor then
    raise exception 'Impossible de modifier son propre statut.'
      using errcode = 'insufficient_privilege';
  end if;

  select p.platform_role, p.account_status
  into v_target_role, v_old_status
  from public.profiles p
  where p.id = p_user_id;

  if v_target_role is null then
    raise exception 'Utilisateur introuvable.' using errcode = 'no_data_found';
  end if;

  -- Un admin ne touche jamais à un super_admin.
  if v_target_role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Seul un super_admin peut modifier un super_admin.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_old_status = p_status then
    return;
  end if;

  -- Suspendre le dernier super_admin actif laisserait la plateforme sans
  -- administrateur suprême : refusé.
  if p_status = 'suspended' and v_target_role = 'super_admin' and not exists (
    select 1 from public.profiles p
    where p.platform_role = 'super_admin'
      and p.account_status = 'active'
      and p.id <> p_user_id
  ) then
    raise exception 'Impossible de suspendre le dernier super_admin.'
      using errcode = 'check_violation';
  end if;

  update public.profiles set account_status = p_status where id = p_user_id;

  perform public.admin_audit(
    v_actor,
    case when p_status = 'suspended' then 'user.suspended' else 'user.reactivated' end,
    'user',
    p_user_id::text,
    jsonb_build_object('from', v_old_status, 'to', p_status)
  );
end;
$$;

-- 5b. Rôle plateforme
create or replace function public.admin_set_platform_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := (select auth.uid());
  v_actor_role  text := public.current_platform_role();
  v_target_role text;
  v_super_count integer;
begin
  perform public.assert_platform_role(array['admin', 'super_admin']);

  if p_role not in ('user', 'support', 'admin', 'super_admin') then
    raise exception 'Rôle invalide.' using errcode = 'invalid_parameter_value';
  end if;

  select p.platform_role into v_target_role
  from public.profiles p
  where p.id = p_user_id;

  if v_target_role is null then
    raise exception 'Utilisateur introuvable.' using errcode = 'no_data_found';
  end if;

  -- Son propre rôle : interdit, sauf démission d'un super_admin (qui reste
  -- soumise à la protection du dernier super_admin ci-dessous).
  if p_user_id = v_actor
     and not (v_actor_role = 'super_admin' and p_role <> 'super_admin') then
    raise exception 'Impossible de modifier son propre rôle.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_actor_role <> 'super_admin' then
    -- admin : jamais super_admin, ni en cible ni en valeur.
    if p_role = 'super_admin' or v_target_role = 'super_admin' then
      raise exception 'Seul un super_admin peut gérer le rôle super_admin.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Il doit toujours rester au moins un super_admin actif (hors la cible).
  if v_target_role = 'super_admin' and p_role <> 'super_admin' then
    select count(*) into v_super_count
    from public.profiles p
    where p.platform_role = 'super_admin'
      and p.account_status = 'active'
      and p.id <> p_user_id;
    if v_super_count < 1 then
      raise exception 'Impossible de rétrograder le dernier super_admin.'
        using errcode = 'check_violation';
    end if;
  end if;

  if v_target_role = p_role then
    return;
  end if;

  update public.profiles set platform_role = p_role where id = p_user_id;

  perform public.admin_audit(
    v_actor, 'user.role_changed', 'user', p_user_id::text,
    jsonb_build_object('from', v_target_role, 'to', p_role)
  );
end;
$$;

-- 5c. Full Access : accorder
create or replace function public.admin_grant_full_access(
  p_workspace_id uuid,
  p_ends_at timestamptz default null,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  perform public.assert_platform_role(array['admin', 'super_admin']);

  if not exists (select 1 from public.workspaces w where w.id = p_workspace_id) then
    raise exception 'Workspace introuvable.' using errcode = 'no_data_found';
  end if;

  if p_ends_at is not null and p_ends_at <= now() then
    raise exception 'La date de fin doit être dans le futur.'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.workspace_entitlements
    (workspace_id, access_mode, starts_at, ends_at, reason, granted_by)
  values
    (p_workspace_id, 'full_access', now(), p_ends_at, nullif(trim(p_reason), ''), v_actor)
  on conflict (workspace_id) do update
    set access_mode = 'full_access',
        starts_at   = now(),
        ends_at     = excluded.ends_at,
        reason      = excluded.reason,
        granted_by  = excluded.granted_by;

  perform public.admin_audit(
    v_actor, 'workspace.full_access_granted', 'workspace', p_workspace_id::text,
    jsonb_build_object('ends_at', p_ends_at, 'reason', nullif(trim(p_reason), ''))
  );
end;
$$;

-- 5d. Full Access : retirer
create or replace function public.admin_revoke_full_access(
  p_workspace_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_mode  text;
begin
  perform public.assert_platform_role(array['admin', 'super_admin']);

  select e.access_mode into v_mode
  from public.workspace_entitlements e
  where e.workspace_id = p_workspace_id;

  if v_mode is distinct from 'full_access' then
    return;
  end if;

  update public.workspace_entitlements
  set access_mode = 'standard',
      ends_at     = null,
      reason      = nullif(trim(p_reason), ''),
      granted_by  = v_actor
  where workspace_id = p_workspace_id;

  perform public.admin_audit(
    v_actor, 'workspace.full_access_revoked', 'workspace', p_workspace_id::text,
    jsonb_build_object('reason', nullif(trim(p_reason), ''))
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- 6. RPC d'administration — LECTURES
-- ---------------------------------------------------------------------------
-- Les e-mails vivent dans auth.users : ces lectures passent par des fonctions
-- `security definer` (première instruction = contrôle du rôle).

create or replace function public.admin_dashboard_stats()
returns table (
  users_total      bigint,
  users_active     bigint,
  users_suspended  bigint,
  workspaces_total bigint,
  full_access_workspaces bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select public.assert_platform_role(array['support', 'admin', 'super_admin']);
  select
    (select count(*) from public.profiles),
    (select count(*) from public.profiles where account_status = 'active'),
    (select count(*) from public.profiles where account_status = 'suspended'),
    (select count(*) from public.workspaces),
    (select count(*) from public.workspace_entitlements e
      where e.access_mode = 'full_access' and (e.ends_at is null or e.ends_at > now()));
$$;

create or replace function public.admin_list_users(
  p_search text default null,
  p_status text default null,
  p_role   text default null,
  p_limit  integer default 25,
  p_offset integer default 0
)
returns table (
  id               uuid,
  email            text,
  display_name     text,
  platform_role    text,
  account_status   text,
  workspace_count  bigint,
  created_at       timestamptz,
  last_sign_in_at  timestamptz,
  total_count      bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select public.assert_platform_role(array['support', 'admin', 'super_admin']);
  with filtered as (
    select
      p.id,
      u.email::text                       as email,
      p.display_name,
      p.platform_role,
      p.account_status,
      (select count(*) from public.workspace_members m where m.user_id = p.id) as workspace_count,
      p.created_at,
      u.last_sign_in_at
    from public.profiles p
    join auth.users u on u.id = p.id
    where (p_status is null or p.account_status = p_status)
      and (p_role is null or p.platform_role = p_role)
      and (
        p_search is null or trim(p_search) = ''
        or u.email ilike '%' || trim(p_search) || '%'
        or coalesce(p.display_name, '') ilike '%' || trim(p_search) || '%'
      )
  )
  select f.*, count(*) over () as total_count
  from filtered f
  order by f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 25), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

create or replace function public.admin_get_user(p_user_id uuid)
returns table (
  id               uuid,
  email            text,
  display_name     text,
  avatar_url       text,
  platform_role    text,
  account_status   text,
  created_at       timestamptz,
  last_sign_in_at  timestamptz,
  email_confirmed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select public.assert_platform_role(array['support', 'admin', 'super_admin']);
  select p.id, u.email::text, p.display_name, p.avatar_url, p.platform_role,
         p.account_status, p.created_at, u.last_sign_in_at, u.email_confirmed_at
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.id = p_user_id;
$$;

create or replace function public.admin_user_workspaces(p_user_id uuid)
returns table (
  workspace_id  uuid,
  name          text,
  slug          text,
  role          text,
  access_mode   text,
  ends_at       timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select public.assert_platform_role(array['support', 'admin', 'super_admin']);
  select w.id, w.name, w.slug, m.role,
         coalesce(e.access_mode, 'standard'), e.ends_at
  from public.workspace_members m
  join public.workspaces w on w.id = m.workspace_id
  left join public.workspace_entitlements e on e.workspace_id = w.id
  where m.user_id = p_user_id
  order by m.created_at;
$$;

create or replace function public.admin_list_workspaces(
  p_search text default null,
  p_limit  integer default 25,
  p_offset integer default 0
)
returns table (
  id            uuid,
  name          text,
  slug          text,
  owner_id      uuid,
  owner_email   text,
  owner_name    text,
  member_count  bigint,
  access_mode   text,
  ends_at       timestamptz,
  created_at    timestamptz,
  total_count   bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select public.assert_platform_role(array['support', 'admin', 'super_admin']);
  with filtered as (
    select
      w.id, w.name, w.slug, w.owner_id,
      u.email::text as owner_email,
      p.display_name as owner_name,
      (select count(*) from public.workspace_members m where m.workspace_id = w.id) as member_count,
      coalesce(e.access_mode, 'standard') as access_mode,
      e.ends_at,
      w.created_at
    from public.workspaces w
    join auth.users u on u.id = w.owner_id
    left join public.profiles p on p.id = w.owner_id
    left join public.workspace_entitlements e on e.workspace_id = w.id
    where p_search is null or trim(p_search) = ''
       or w.name ilike '%' || trim(p_search) || '%'
       or w.slug ilike '%' || trim(p_search) || '%'
       or u.email ilike '%' || trim(p_search) || '%'
       or coalesce(p.display_name, '') ilike '%' || trim(p_search) || '%'
  )
  select f.*, count(*) over () as total_count
  from filtered f
  order by f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 25), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

create or replace function public.admin_get_workspace(p_workspace_id uuid)
returns table (
  id            uuid,
  name          text,
  slug          text,
  owner_id      uuid,
  owner_email   text,
  owner_name    text,
  access_mode   text,
  starts_at     timestamptz,
  ends_at       timestamptz,
  reason        text,
  granted_by    uuid,
  granted_by_email text,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select public.assert_platform_role(array['support', 'admin', 'super_admin']);
  select w.id, w.name, w.slug, w.owner_id, u.email::text, p.display_name,
         coalesce(e.access_mode, 'standard'), e.starts_at, e.ends_at, e.reason,
         e.granted_by, g.email::text, w.created_at
  from public.workspaces w
  join auth.users u on u.id = w.owner_id
  left join public.profiles p on p.id = w.owner_id
  left join public.workspace_entitlements e on e.workspace_id = w.id
  left join auth.users g on g.id = e.granted_by
  where w.id = p_workspace_id;
$$;

create or replace function public.admin_workspace_members(p_workspace_id uuid)
returns table (
  user_id       uuid,
  email         text,
  display_name  text,
  role          text,
  account_status text,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select public.assert_platform_role(array['support', 'admin', 'super_admin']);
  select m.user_id, u.email::text, p.display_name, m.role, p.account_status, m.created_at
  from public.workspace_members m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.workspace_id = p_workspace_id
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.created_at;
$$;

create or replace function public.admin_list_audit_logs(
  p_limit  integer default 50,
  p_offset integer default 0
)
returns table (
  id             uuid,
  actor_user_id  uuid,
  actor_email    text,
  action         text,
  target_type    text,
  target_id      text,
  metadata       jsonb,
  created_at     timestamptz,
  total_count    bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select public.assert_platform_role(array['admin', 'super_admin']);
  select l.id, l.actor_user_id, u.email::text, l.action, l.target_type, l.target_id,
         l.metadata, l.created_at, count(*) over () as total_count
  from public.admin_audit_logs l
  left join auth.users u on u.id = l.actor_user_id
  order by l.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
$$;


-- ---------------------------------------------------------------------------
-- 7. Compte suspendu : plus de création de workspace
-- ---------------------------------------------------------------------------
-- Complète (sans la remplacer côté application) la vérification serveur :
-- la RPC C4 refuse désormais un appelant dont le compte n'est pas actif.
-- Le corps est identique à C4, plus ce contrôle.

create or replace function public.create_workspace(p_name text)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_name text := trim(coalesce(p_name, ''));
  v_base text;
  v_ws   public.workspaces;
begin
  if v_uid is null then
    raise exception 'Authentification requise.'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_uid and p.account_status = 'active'
  ) then
    raise exception 'Compte suspendu.'
      using errcode = 'insufficient_privilege';
  end if;

  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'Le nom du workspace doit contenir entre 1 et 80 caractères.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_base := coalesce(public.slugify(v_name), 'workspace');

  for attempt in 1..5 loop
    begin
      insert into public.workspaces (name, slug, owner_id)
      values (v_name, public.next_workspace_slug(v_base), v_uid)
      returning * into v_ws;
      exit;
    exception
      when unique_violation then
        if attempt = 5 then
          raise;
        end if;
    end;
  end loop;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_ws.id, v_uid, 'owner');

  return v_ws;
end;
$$;


-- ---------------------------------------------------------------------------
-- 8. RLS
-- ---------------------------------------------------------------------------

alter table public.workspace_entitlements enable row level security;
alter table public.admin_audit_logs enable row level security;

-- Personnel plateforme : lecture de tous les profils / workspaces / memberships.
drop policy if exists profiles_select_staff on public.profiles;
create policy profiles_select_staff
  on public.profiles for select to authenticated
  using (public.is_platform_staff());

drop policy if exists workspaces_select_staff on public.workspaces;
create policy workspaces_select_staff
  on public.workspaces for select to authenticated
  using (public.is_platform_staff());

drop policy if exists workspace_members_select_staff on public.workspace_members;
create policy workspace_members_select_staff
  on public.workspace_members for select to authenticated
  using (public.is_platform_staff());

-- Entitlements : visibles par les membres du workspace et par le personnel.
drop policy if exists workspace_entitlements_select_member on public.workspace_entitlements;
create policy workspace_entitlements_select_member
  on public.workspace_entitlements for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_staff());

-- Audit : admin et super_admin seulement.
drop policy if exists admin_audit_logs_select_admin on public.admin_audit_logs;
create policy admin_audit_logs_select_admin
  on public.admin_audit_logs for select to authenticated
  using (coalesce(public.current_platform_role() in ('admin', 'super_admin'), false));

-- Aucune politique d'écriture : tout passe par les RPC.


-- ---------------------------------------------------------------------------
-- 9. Privilèges
-- ---------------------------------------------------------------------------

revoke all on public.workspace_entitlements from anon, authenticated;
grant select on public.workspace_entitlements to authenticated;

revoke all on public.admin_audit_logs from anon, authenticated;
grant select on public.admin_audit_logs to authenticated;

-- Fonctions : révocation des droits par défaut, puis exposition ciblée.
revoke all on function public.current_platform_role()                          from public, anon, authenticated;
revoke all on function public.is_platform_staff()                              from public, anon, authenticated;
revoke all on function public.assert_platform_role(text[])                     from public, anon, authenticated;
revoke all on function public.workspace_has_full_access(uuid)                  from public, anon, authenticated;
revoke all on function public.admin_audit(uuid, text, text, text, jsonb)       from public, anon, authenticated;
revoke all on function public.admin_set_account_status(uuid, text)             from public, anon, authenticated;
revoke all on function public.admin_set_platform_role(uuid, text)              from public, anon, authenticated;
revoke all on function public.admin_grant_full_access(uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.admin_revoke_full_access(uuid, text)             from public, anon, authenticated;
revoke all on function public.admin_dashboard_stats()                          from public, anon, authenticated;
revoke all on function public.admin_list_users(text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_get_user(uuid)                             from public, anon, authenticated;
revoke all on function public.admin_user_workspaces(uuid)                      from public, anon, authenticated;
revoke all on function public.admin_list_workspaces(text, integer, integer)    from public, anon, authenticated;
revoke all on function public.admin_get_workspace(uuid)                        from public, anon, authenticated;
revoke all on function public.admin_workspace_members(uuid)                    from public, anon, authenticated;
revoke all on function public.admin_list_audit_logs(integer, integer)          from public, anon, authenticated;

grant execute on function public.current_platform_role()                          to authenticated;
grant execute on function public.is_platform_staff()                              to authenticated;
grant execute on function public.workspace_has_full_access(uuid)                  to authenticated;
grant execute on function public.admin_set_account_status(uuid, text)             to authenticated;
grant execute on function public.admin_set_platform_role(uuid, text)              to authenticated;
grant execute on function public.admin_grant_full_access(uuid, timestamptz, text) to authenticated;
grant execute on function public.admin_revoke_full_access(uuid, text)             to authenticated;
grant execute on function public.admin_dashboard_stats()                          to authenticated;
grant execute on function public.admin_list_users(text, text, text, integer, integer) to authenticated;
grant execute on function public.admin_get_user(uuid)                             to authenticated;
grant execute on function public.admin_user_workspaces(uuid)                      to authenticated;
grant execute on function public.admin_list_workspaces(text, integer, integer)    to authenticated;
grant execute on function public.admin_get_workspace(uuid)                        to authenticated;
grant execute on function public.admin_workspace_members(uuid)                    to authenticated;
grant execute on function public.admin_list_audit_logs(integer, integer)          to authenticated;

-- `assert_platform_role` et `admin_audit` restent internes (appelés par les
-- RPC, qui s'exécutent avec les droits du propriétaire).
