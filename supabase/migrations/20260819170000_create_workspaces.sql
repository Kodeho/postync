-- ===========================================================================
-- POSTYNC — C4 : workspaces, workspace_members, création atomique, RLS
-- ===========================================================================
-- Fondation multi-tenant. Un utilisateur peut appartenir à plusieurs
-- workspaces ; chaque workspace est strictement isolé des autres.
--
-- Principes :
--   * l'UUID est la référence interne, le slug n'est qu'une adresse lisible ;
--   * la création passe EXCLUSIVEMENT par la RPC `create_workspace()` ;
--   * le rôle `authenticated` n'a AUCUN droit d'écriture sur
--     `workspace_members` : aucune escalade possible par l'API REST ;
--   * `workspaces.owner_id` et la ligne `workspace_members.role = 'owner'`
--     sont maintenus cohérents par des triggers ;
--   * la migration C3 (`profiles`) n'est pas modifiée.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Table `workspaces`
-- ---------------------------------------------------------------------------

create table if not exists public.workspaces (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  slug        text        not null,
  -- `restrict` : on ne supprime jamais un workspace « par accident » parce
  -- que le compte de son propriétaire disparaît. Le transfert ou la
  -- suppression explicite du workspace doit précéder la suppression du compte.
  owner_id    uuid        not null references auth.users (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint workspaces_name_length
    check (char_length(trim(name)) between 1 and 80),

  -- Slug normalisé : minuscules, chiffres, tirets simples, sans tiret aux
  -- extrémités. La contrainte DB est la source de vérité, pas le navigateur.
  constraint workspaces_slug_format
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),

  constraint workspaces_slug_unique unique (slug)
);

create index if not exists workspaces_owner_id_idx on public.workspaces (owner_id);

comment on table public.workspaces is
  'Espace de travail (tenant) POSTYNC. L''UUID est la clé métier ; le slug est une adresse lisible.';
comment on column public.workspaces.owner_id is
  'Propriétaire. Doit correspondre à la ligne workspace_members de rôle owner (triggers).';

drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 2. Table `workspace_members`
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_members (
  id            uuid        primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  user_id       uuid        not null references auth.users (id) on delete cascade,
  role          text        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Doit rester aligné sur src/types/workspace-role.ts
  constraint workspace_members_role_check
    check (role in ('owner', 'admin', 'member')),

  -- Un utilisateur n'apparaît qu'une fois par workspace.
  constraint workspace_members_unique unique (workspace_id, user_id)
);

create index if not exists workspace_members_user_id_idx
  on public.workspace_members (user_id);

-- Un seul owner par workspace.
create unique index if not exists workspace_members_single_owner_idx
  on public.workspace_members (workspace_id)
  where role = 'owner';

comment on table public.workspace_members is
  'Appartenance utilisateur/workspace avec rôle (owner, admin, member). Rôle workspace, sans lien avec profiles.platform_role.';

drop trigger if exists workspace_members_set_updated_at on public.workspace_members;
create trigger workspace_members_set_updated_at
  before update on public.workspace_members
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 3. Cohérence owner_id <-> membership owner (triggers)
-- ---------------------------------------------------------------------------
-- Évite les états incohérents du type :
--   workspaces.owner_id = A  mais  workspace_members(A) = member
-- Le transfert de propriété n'existe pas en C4 : toute modification de
-- `owner_id` est refusée. Une future RPC de transfert remplacera ce trigger.

create or replace function public.prevent_owner_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'Le transfert de propriété d''un workspace n''est pas pris en charge.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists workspaces_prevent_owner_change on public.workspaces;
create trigger workspaces_prevent_owner_change
  before update on public.workspaces
  for each row
  execute function public.prevent_owner_change();

-- Sur workspace_members :
--   * insert : seul owner_id peut recevoir le rôle owner ;
--   * update : la ligne du owner est immuable, personne d'autre ne peut
--     recevoir le rôle owner ;
--   * delete : la ligne du owner ne peut pas être supprimée tant que le
--     workspace existe (la cascade de suppression du workspace reste permise).
create or replace function public.protect_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid := coalesce(new.workspace_id, old.workspace_id);
  v_owner_id     uuid;
begin
  select w.owner_id into v_owner_id
  from public.workspaces w
  where w.id = v_workspace_id;

  -- Workspace déjà supprimé (cascade en cours) : rien à protéger.
  if v_owner_id is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.user_id = v_owner_id then
      raise exception 'Le propriétaire du workspace ne peut pas être retiré.'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.user_id = v_owner_id then
    if new.user_id <> old.user_id
       or new.workspace_id <> old.workspace_id
       or new.role <> 'owner' then
      raise exception 'L''appartenance du propriétaire ne peut pas être modifiée.'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.role = 'owner' and new.user_id <> v_owner_id then
    raise exception 'Seul workspaces.owner_id peut porter le rôle owner.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_members_protect_owner on public.workspace_members;
create trigger workspace_members_protect_owner
  before insert or update or delete on public.workspace_members
  for each row
  execute function public.protect_owner_membership();


-- ---------------------------------------------------------------------------
-- 4. Slug
-- ---------------------------------------------------------------------------
-- "Mon Agence" -> "mon-agence". Sans dépendance à l'extension unaccent :
-- les caractères accentués courants sont translittérés explicitement.

create or replace function public.slugify(input text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select nullif(
    left(
      trim(both '-' from
        regexp_replace(
          translate(
            lower(input),
            'àáâãäåāçćčèéêëēėęìíîïīįñńòóôõöøōùúûüūųýÿžźżšśßœæ',
            'aaaaaaaccceeeeeeeiiiiiinnooooooouuuuuuyyzzzsssoa'
          ),
          '[^a-z0-9]+', '-', 'g'
        )
      ),
      50
    ),
    ''
  );
$$;

-- Premier slug libre parmi base, base-2, base-3, …  (déterministe).
-- Lue sans RLS car appelée depuis `create_workspace` (security definer).
create or replace function public.next_workspace_slug(base text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_base text := coalesce(base, 'workspace');
  v_n    integer := 1;
  v_slug text := v_base;
begin
  while exists (select 1 from public.workspaces w where w.slug = v_slug) loop
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  end loop;
  return v_slug;
end;
$$;


-- ---------------------------------------------------------------------------
-- 5. RPC `create_workspace(p_name)` — création atomique
-- ---------------------------------------------------------------------------
-- INSERT workspaces + INSERT workspace_members(owner) dans une seule
-- transaction. `security definer` car `authenticated` n'a aucun droit
-- d'insertion direct. Le propriétaire est TOUJOURS auth.uid() : aucun
-- owner_id fourni par le client n'est accepté.

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

  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'Le nom du workspace doit contenir entre 1 et 80 caractères.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_base := coalesce(public.slugify(v_name), 'workspace');

  -- En cas de course entre deux créations simultanées sur le même slug, la
  -- contrainte unique tranche et l'on recalcule (au plus 5 essais).
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
-- 6. Fonctions d'aide RLS
-- ---------------------------------------------------------------------------
-- Les politiques de `workspaces` et de `workspace_members` dépendent toutes
-- deux de `workspace_members`. Une politique qui lirait directement cette
-- table depuis elle-même provoquerait une récursion infinie de RLS : ces
-- fonctions `security definer` lisent l'appartenance sans repasser par RLS,
-- et ne renvoient que des informations relatives à auth.uid() lui-même.

create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.workspace_role(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.workspace_members m
  where m.workspace_id = p_workspace_id
    and m.user_id = (select auth.uid())
  limit 1;
$$;


-- ---------------------------------------------------------------------------
-- 7. Row Level Security
-- ---------------------------------------------------------------------------
-- RLS n'est jamais désactivée pour contourner un problème.

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

-- workspaces : lecture réservée aux membres.
drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member
  on public.workspaces
  for select
  to authenticated
  using (public.is_workspace_member(id));

-- workspaces : modification réservée à owner et admin (colonne `name`
-- seulement, voir les privilèges de colonnes plus bas).
drop policy if exists workspaces_update_owner_admin on public.workspaces;
create policy workspaces_update_owner_admin
  on public.workspaces
  for update
  to authenticated
  using (public.workspace_role(id) in ('owner', 'admin'))
  with check (public.workspace_role(id) in ('owner', 'admin'));

-- Aucune politique INSERT ni DELETE : création via `create_workspace()`,
-- suppression via une future RPC contrôlée.

-- workspace_members : un membre voit les memberships de SES workspaces.
drop policy if exists workspace_members_select_member on public.workspace_members;
create policy workspace_members_select_member
  on public.workspace_members
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

-- Aucune politique INSERT / UPDATE / DELETE sur workspace_members : toute
-- gestion de membres passera par des RPC `security definer` dédiées.


-- ---------------------------------------------------------------------------
-- 8. Privilèges (défense en profondeur, indépendante de RLS)
-- ---------------------------------------------------------------------------
-- Supabase accorde par défaut tous les droits à anon/authenticated sur les
-- nouveaux objets de `public` : on les retire explicitement.

revoke all on public.workspaces from anon, authenticated;
grant select on public.workspaces to authenticated;
grant update (name) on public.workspaces to authenticated;

revoke all on public.workspace_members from anon, authenticated;
grant select on public.workspace_members to authenticated;
-- Ni insert, ni update, ni delete : un PATCH REST sur `role` échoue avec
-- « permission denied », avant même l'évaluation des politiques.

-- Fonctions : seules `create_workspace`, `is_workspace_member` et
-- `workspace_role` sont exposées au rôle authenticated.
revoke all on function public.create_workspace(text)       from public, anon, authenticated;
revoke all on function public.is_workspace_member(uuid)    from public, anon, authenticated;
revoke all on function public.workspace_role(uuid)         from public, anon, authenticated;
revoke all on function public.slugify(text)                from public, anon, authenticated;
revoke all on function public.next_workspace_slug(text)    from public, anon, authenticated;
revoke all on function public.prevent_owner_change()       from public, anon, authenticated;
revoke all on function public.protect_owner_membership()   from public, anon, authenticated;

grant execute on function public.create_workspace(text)    to authenticated;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.workspace_role(uuid)      to authenticated;

-- `service_role` conserve ses privilèges complets (administration serveur).
