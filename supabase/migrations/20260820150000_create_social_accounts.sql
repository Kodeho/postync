-- ===========================================================================
-- POSTYNC — C8.1 : fondation des comptes sociaux (social_accounts,
--                  oauth_states, intégration Supabase Vault)
-- ===========================================================================
-- Principes :
--   * une connexion sociale appartient au WORKSPACE (comme l'abonnement C7) ;
--     l'utilisateur qui l'initie n'est que tracé (`connected_by`) ;
--   * AUCUN token (access, refresh) ni code_verifier PKCE n'est stocké dans
--     une table applicative : uniquement des références vers Supabase Vault
--     (chiffrement authentifié, clés hors base) ;
--   * le schéma `vault` n'est ni exposé par PostgREST ni accessible aux rôles
--     anon/authenticated ; l'application y accède par les wrappers
--     `social_vault_*` ci-dessous, exécutables par service_role UNIQUEMENT ;
--   * écritures applicatives : exclusivement côté serveur (Server Actions et
--     callback OAuth, via service client) — aucune politique RLS d'écriture ;
--   * les migrations C3→C7 ne sont pas modifiées.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Wrappers Vault (double verrou : REVOKE + service_role only)
-- ---------------------------------------------------------------------------
-- `security definer` (propriétaire postgres) pour atteindre le schéma vault ;
-- EXECUTE retiré à public/anon/authenticated : seul service_role (donc le
-- serveur POSTYNC) peut stocker, lire ou supprimer un secret.

create or replace function public.social_vault_store(p_secret text, p_name text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select vault.create_secret(p_secret, p_name || '/' || gen_random_uuid()::text, 'POSTYNC social token');
$$;

create or replace function public.social_vault_read(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.id = p_id;
$$;

create or replace function public.social_vault_delete(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from vault.secrets where id = p_id;
$$;

revoke all on function public.social_vault_store(text, text) from public, anon, authenticated;
revoke all on function public.social_vault_read(uuid)        from public, anon, authenticated;
revoke all on function public.social_vault_delete(uuid)      from public, anon, authenticated;
grant execute on function public.social_vault_store(text, text) to service_role;
grant execute on function public.social_vault_read(uuid)        to service_role;
grant execute on function public.social_vault_delete(uuid)      to service_role;


-- ---------------------------------------------------------------------------
-- 2. Table social_accounts
-- ---------------------------------------------------------------------------

create table if not exists public.social_accounts (
  id                   uuid        primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  platform             text        not null,
  provider_account_id  text        not null,
  display_name         text,
  avatar_url           text,
  -- Références Vault. JAMAIS de token en clair ici.
  access_token_id      uuid        not null,
  refresh_token_id     uuid,
  token_expires_at     timestamptz,          -- null = non expirant (Page token Meta)
  refresh_expires_at   timestamptz,          -- TikTok : 365 jours
  scopes               text[]      not null default '{}',
  status               text        not null default 'active',
  status_detail        text,                 -- code court non sensible (jamais de token)
  connected_by         uuid        references auth.users (id) on delete set null,
  connected_at         timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Aligné sur src/types/platform.ts
  constraint social_accounts_platform_check
    check (platform in ('instagram', 'facebook', 'tiktok', 'youtube')),
  constraint social_accounts_status_check
    check (status in ('active', 'expired', 'revoked', 'error')),
  constraint social_accounts_provider_id_length
    check (char_length(provider_account_id) between 1 and 128),
  -- Multi-comptes autorisé ; le MÊME compte ne peut pas être connecté deux
  -- fois au même workspace (la reconnexion met à jour la ligne existante).
  constraint social_accounts_unique unique (workspace_id, platform, provider_account_id)
);

create index if not exists social_accounts_workspace_id_idx
  on public.social_accounts (workspace_id);

comment on table public.social_accounts is
  'Connexions sociales d''un workspace. Tokens dans Vault uniquement (access_token_id / refresh_token_id).';

drop trigger if exists social_accounts_set_updated_at on public.social_accounts;
create trigger social_accounts_set_updated_at
  before update on public.social_accounts
  for each row
  execute function public.set_updated_at();

-- Nettoyage Vault garanti, y compris lors d'une suppression en cascade du
-- workspace : les secrets meurent avec la ligne.
create or replace function public.social_accounts_purge_secrets()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.access_token_id is not null then
    delete from vault.secrets where id = old.access_token_id;
  end if;
  if old.refresh_token_id is not null then
    delete from vault.secrets where id = old.refresh_token_id;
  end if;
  return old;
end;
$$;

drop trigger if exists social_accounts_purge_secrets on public.social_accounts;
create trigger social_accounts_purge_secrets
  after delete on public.social_accounts
  for each row
  execute function public.social_accounts_purge_secrets();


-- ---------------------------------------------------------------------------
-- 3. Table oauth_states (anti-CSRF, usage unique, TTL court)
-- ---------------------------------------------------------------------------
-- On ne stocke que le HACHAGE SHA-256 du state : un dump de la table ne
-- permet pas de forger un callback. Le code_verifier PKCE vit dans Vault.

create table if not exists public.oauth_states (
  id                uuid        primary key default gen_random_uuid(),
  state_hash        text        not null unique,
  workspace_id      uuid        not null references public.workspaces (id) on delete cascade,
  user_id           uuid        not null references auth.users (id) on delete cascade,
  platform          text        not null,
  code_verifier_id  uuid,                    -- référence Vault (PKCE), nullable
  redirect_slug     text        not null,    -- slug du workspace pour le retour UI
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  consumed_at       timestamptz,

  constraint oauth_states_platform_check
    check (platform in ('instagram', 'facebook', 'tiktok', 'youtube')),
  constraint oauth_states_hash_format
    check (state_hash ~ '^[a-f0-9]{64}$'),
  constraint oauth_states_ttl_check
    check (expires_at > created_at)
);

create index if not exists oauth_states_expires_at_idx
  on public.oauth_states (expires_at);

comment on table public.oauth_states is
  'États OAuth en cours (hachés). Usage unique, TTL court, purement serveur.';

create or replace function public.oauth_states_purge_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.code_verifier_id is not null then
    delete from vault.secrets where id = old.code_verifier_id;
  end if;
  return old;
end;
$$;

drop trigger if exists oauth_states_purge_secret on public.oauth_states;
create trigger oauth_states_purge_secret
  after delete on public.oauth_states
  for each row
  execute function public.oauth_states_purge_secret();


-- ---------------------------------------------------------------------------
-- 4. RLS et privilèges
-- ---------------------------------------------------------------------------

alter table public.social_accounts enable row level security;
alter table public.oauth_states enable row level security;

-- Lecture : membres du workspace (page /accounts) et personnel plateforme.
drop policy if exists social_accounts_select on public.social_accounts;
create policy social_accounts_select
  on public.social_accounts for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_staff());

-- oauth_states : AUCUNE politique — table invisible pour authenticated/anon.

-- Aucune politique d'écriture nulle part : Server Actions + callback via
-- service client, après contrôle applicatif (session, rôle owner/admin).

revoke all on public.social_accounts from anon, authenticated;
-- Liste blanche de colonnes : les références Vault (access_token_id,
-- refresh_token_id) sont EXCLUES — même un membre légitime ne peut pas les
-- sélectionner (permission denied), en plus du verrou sur les wrappers.
grant select (id, workspace_id, platform, provider_account_id, display_name,
              avatar_url, token_expires_at, refresh_expires_at, scopes,
              status, status_detail, connected_by, connected_at,
              created_at, updated_at)
  on public.social_accounts to authenticated;

revoke all on public.oauth_states from anon, authenticated;

-- Les triggers restent internes.
revoke all on function public.social_accounts_purge_secrets() from public, anon, authenticated;
revoke all on function public.oauth_states_purge_secret()     from public, anon, authenticated;
