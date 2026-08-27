-- ===========================================================================
-- POSTYNC — C8.4b : trace des publications sociales (social_publications)
-- ===========================================================================
-- Pourquoi une table alors que la publication pourrait être « tirée puis
-- oubliée » : le plan commercial (C7) porte déjà un quota
-- `publicationsPerMonth`. Sans trace, ce quota serait inapplicable et un
-- workspace Free publierait sans limite. La table sert donc à trois choses :
--   1. faire respecter le quota du plan ;
--   2. reprendre une publication restée en cours (un conteneur Instagram
--      reste valide 24 h : on ne réenvoie jamais le média, on reprend) ;
--   3. donner une trace consultable par le workspace.
--
-- Mêmes principes que C8.1 :
--   * la publication appartient au WORKSPACE, l'utilisateur n'est que tracé ;
--   * aucune écriture par `authenticated` : Server Actions via service client
--     après contrôle de session et de rôle ;
--   * lecture par les membres du workspace et le personnel plateforme ;
--   * AUCUN secret dans cette table.
-- ===========================================================================

create table if not exists public.social_publications (
  id                   uuid        primary key default gen_random_uuid(),
  workspace_id         uuid        not null references public.workspaces (id) on delete cascade,
  -- Le compte peut être déconnecté après coup : la trace lui survit.
  social_account_id    uuid        references public.social_accounts (id) on delete set null,
  platform             text        not null,
  provider_account_id  text        not null,
  media_kind           text        not null,
  -- URL PUBLIQUE du média source. Instagram exige un média accessible
  -- publiquement : cette colonne ne doit JAMAIS recevoir une URL signée ou
  -- porteuse d'un identifiant d'accès. Quand l'étape « media » apportera un
  -- stockage, y placer la clé de l'objet, pas l'URL signée.
  media_url            text        not null,
  caption              text,
  -- Conteneur distant (Instagram : valide 24 h) : permet la reprise.
  container_id         text,
  provider_media_id    text,
  permalink            text,
  status               text        not null default 'pending',
  -- Code court non sensible (jamais de token, jamais de payload brut).
  status_detail        text,
  requested_by         uuid        references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  published_at         timestamptz,
  updated_at           timestamptz not null default now(),

  -- Aligné sur src/types/platform.ts
  constraint social_publications_platform_check
    check (platform in ('instagram', 'facebook', 'tiktok', 'youtube')),
  constraint social_publications_media_kind_check
    check (media_kind in ('reel', 'image')),
  constraint social_publications_status_check
    check (status in ('pending', 'published', 'failed')),
  constraint social_publications_caption_length
    check (caption is null or char_length(caption) <= 2200),
  -- Une publication aboutie porte forcément l'identifiant distant et sa date.
  constraint social_publications_published_shape
    check (
      status <> 'published'
      or (provider_media_id is not null and published_at is not null)
    )
);

-- Quota mensuel et affichage : toujours filtrés par workspace puis par date.
create index if not exists social_publications_workspace_created_idx
  on public.social_publications (workspace_id, created_at desc);

-- Reprise des publications restées en cours.
create index if not exists social_publications_pending_idx
  on public.social_publications (workspace_id, status)
  where status = 'pending';

comment on table public.social_publications is
  'Publications sociales d''un workspace : quota du plan, reprise des conteneurs en cours, trace. Aucun secret.';

drop trigger if exists social_publications_set_updated_at on public.social_publications;
create trigger social_publications_set_updated_at
  before update on public.social_publications
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- RLS et privilèges
-- ---------------------------------------------------------------------------

alter table public.social_publications enable row level security;

drop policy if exists social_publications_select on public.social_publications;
create policy social_publications_select
  on public.social_publications for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_staff());

-- Aucune politique d'écriture : les Server Actions écrivent via service_role,
-- après vérification de la session, du rôle owner/admin et du quota du plan.

revoke all on public.social_publications from anon, authenticated;
-- Aucune colonne sensible ici, mais la liste reste explicite : une colonne
-- ajoutée plus tard n'est pas lisible tant qu'elle n'est pas ajoutée ici.
grant select (id, workspace_id, social_account_id, platform, provider_account_id,
              media_kind, media_url, caption, container_id, provider_media_id,
              permalink, status, status_detail, requested_by, created_at,
              published_at, updated_at)
  on public.social_publications to authenticated;
