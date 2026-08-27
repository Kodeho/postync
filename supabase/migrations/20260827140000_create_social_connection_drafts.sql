-- ===========================================================================
-- POSTYNC — C8.4c : connexions en attente de sélection d'actif
-- ===========================================================================
-- Pourquoi cette table n'existait pas avant : YouTube, TikTok et Instagram
-- donnent UN compte par autorisation, la ligne `social_accounts` peut donc
-- être créée directement dans le callback. Facebook casse ce modèle — une
-- autorisation donne accès à N Pages, et l'utilisateur doit choisir.
--
-- Entre le callback et ce choix, il faut conserver le jeton UTILISATEUR le
-- temps d'énumérer les Pages. Ce jeton :
--   * ne doit jamais transiter par le navigateur ;
--   * n'a pas vocation à survivre à la sélection (seuls les jetons de PAGE
--     sont conservés dans `social_accounts`) ;
--   * doit disparaître de lui-même si l'utilisateur abandonne.
--
-- D'où un brouillon à durée de vie courte, sur le modèle d'`oauth_states` :
-- purement serveur, invisible pour `authenticated`, secret purgé de Vault par
-- trigger à la suppression.
-- ===========================================================================

create table if not exists public.social_connection_drafts (
  id             uuid        primary key default gen_random_uuid(),
  workspace_id   uuid        not null references public.workspaces (id) on delete cascade,
  user_id        uuid        not null references auth.users (id) on delete cascade,
  platform       text        not null,
  redirect_slug  text        not null,
  -- Référence Vault du jeton utilisateur. JAMAIS de jeton en clair ici.
  user_token_id  uuid        not null,
  scopes         text[]      not null default '{}',
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,

  constraint social_connection_drafts_platform_check
    check (platform in ('instagram', 'facebook', 'tiktok', 'youtube')),
  constraint social_connection_drafts_ttl_check
    check (expires_at > created_at)
);

create index if not exists social_connection_drafts_expires_at_idx
  on public.social_connection_drafts (expires_at);

comment on table public.social_connection_drafts is
  'Connexions OAuth en attente de sélection d''actif (Pages Facebook). Jeton utilisateur dans Vault, TTL court, purement serveur.';

-- Le jeton utilisateur meurt avec le brouillon, y compris en cascade.
create or replace function public.social_connection_drafts_purge_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.user_token_id is not null then
    delete from vault.secrets where id = old.user_token_id;
  end if;
  return old;
end;
$$;

drop trigger if exists social_connection_drafts_purge_secret on public.social_connection_drafts;
create trigger social_connection_drafts_purge_secret
  after delete on public.social_connection_drafts
  for each row
  execute function public.social_connection_drafts_purge_secret();

-- ---------------------------------------------------------------------------
-- RLS et privilèges : table strictement serveur, comme `oauth_states`.
-- ---------------------------------------------------------------------------

alter table public.social_connection_drafts enable row level security;
-- Aucune politique : invisible pour authenticated et anon.

revoke all on public.social_connection_drafts from anon, authenticated;
revoke all on function public.social_connection_drafts_purge_secret() from public, anon, authenticated;
