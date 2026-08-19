-- ===========================================================================
-- POSTYNC — C3 : table `profiles`, création automatique, RLS
-- ===========================================================================
-- Applique : table profiles liée à auth.users, trigger de création de profil,
-- Row Level Security, et verrouillage de `platform_role`.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id            uuid        primary key references auth.users (id) on delete cascade,
  display_name  text,
  avatar_url    text,
  platform_role text        not null default 'user',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Doit rester aligné sur src/types/platform-role.ts
  constraint profiles_platform_role_check
    check (platform_role in ('user', 'support', 'admin', 'super_admin')),

  constraint profiles_display_name_length
    check (display_name is null or char_length(display_name) <= 80)
);

comment on table public.profiles is
  'Profil applicatif POSTYNC, en relation 1-1 avec auth.users.';
comment on column public.profiles.platform_role is
  'Rôle plateforme. Non modifiable par l''utilisateur : voir les GRANT de colonnes plus bas.';


-- ---------------------------------------------------------------------------
-- 2. Horodatage `updated_at`
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 3. Création automatique du profil
-- ---------------------------------------------------------------------------
-- auth.users  ->  trigger on_auth_user_created  ->  public.profiles
--
-- `security definer` est nécessaire : le rôle qui insère dans auth.users lors
-- d'une inscription n'a pas de droit d'écriture sur public.profiles.
--
-- `search_path = ''` neutralise une attaque par détournement de schéma : toutes
-- les références sont donc qualifiées explicitement.
--
-- Le bloc `exception` garantit qu'un champ optionnel absent ou toute autre
-- anomalie ne fait jamais échouer l'inscription elle-même (exigence C3 §8).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta_display_name text;
  meta_avatar_url   text;
begin
  meta_display_name := nullif(
    trim(coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      ''
    )),
    ''
  );

  meta_avatar_url := nullif(
    trim(coalesce(new.raw_user_meta_data ->> 'avatar_url', '')),
    ''
  );

  insert into public.profiles (id, display_name, avatar_url)
  values (new.id, left(meta_display_name, 80), meta_avatar_url)
  on conflict (id) do nothing;

  return new;

exception
  when others then
    -- Ne jamais casser une inscription pour un problème de profil.
    raise warning 'handle_new_user: profil non créé pour % (%)', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();


-- ---------------------------------------------------------------------------
-- 4. Row Level Security
-- ---------------------------------------------------------------------------
-- RLS n'est jamais désactivée pour contourner un problème (interdiction C3 §21).

alter table public.profiles enable row level security;

-- Lecture : uniquement son propre profil.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

-- Modification : uniquement son propre profil.
-- `with check` empêche en plus de réattribuer une ligne à un autre id.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Aucune politique INSERT ni DELETE n'est créée : RLS refuse par défaut.
-- L'insertion passe exclusivement par le trigger `on_auth_user_created`,
-- la suppression par la cascade depuis auth.users.


-- ---------------------------------------------------------------------------
-- 5. Verrouillage de `platform_role` (privilèges de colonnes)
-- ---------------------------------------------------------------------------
-- RLS décide QUELLES LIGNES sont accessibles, pas quelles colonnes.
-- Le passage `user -> super_admin` est donc bloqué au niveau des privilèges
-- PostgreSQL : le rôle `authenticated` n'a tout simplement aucun droit UPDATE
-- sur `platform_role`. Une requête tentant de l'écrire échoue avec
-- « permission denied for column platform_role », y compris en appel direct
-- à l'API REST, hors de toute logique applicative.

revoke all on public.profiles from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

-- `service_role` conserve ses privilèges complets : c'est le seul chemin
-- autorisé pour modifier `platform_role`, avec une migration contrôlée.
