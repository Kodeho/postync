-- ===========================================================================
-- POSTYNC — C9.1 : médiathèque (bucket privé + table media_assets)
-- ===========================================================================
-- Objectif : remplacer la saisie manuelle d'une URL publique par un vrai
-- téléversement, sans jamais ouvrir le stockage au tout-venant.
--
-- STRATÉGIE D'EXPOSITION — le point délicat
--
-- Instagram et Facebook vont chercher le média EUX-MÊMES par HTTPS. Il faut
-- donc qu'une URL leur soit accessible, mais la documentation Supabase est
-- formelle : une réponse mise en cache au CDN continue d'être servie pour la
-- même URL signée « even if the token in that URL has already expired ».
-- L'expiration ne coupe donc PAS l'accès à elle seule ; seule la suppression
-- de l'objet le fait.
--
-- Conséquences, toutes tenues par ce schéma :
--   * bucket PRIVÉ, et aucune politique d'écriture pour `authenticated` —
--     tout passe par le serveur, comme pour `social_accounts` ;
--   * l'URL signée est forgée AU MOMENT de publier, avec une durée courte, et
--     n'est JAMAIS enregistrée en base ni renvoyée au navigateur ;
--   * la table ne stocke que la CLÉ de l'objet — jamais une URL signée ;
--   * supprimer un média supprime réellement l'objet : c'est la seule
--     révocation qui vaille.
--
-- ISOLATION : le premier segment du chemin est l'identifiant du workspace,
-- ce qui rend l'appartenance vérifiable directement sur `storage.objects`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Le bucket
-- ---------------------------------------------------------------------------
-- Les garde-fous de taille et de type sont posés AU NIVEAU DU BUCKET : même
-- un bug applicatif ne pourra pas y déposer un exécutable de 2 Go.
--   * 300 Mo = plafond commun aux Reels Instagram et Facebook ;
--   * MP4/MOV pour la vidéo, JPEG pour l'image (seul format accepté par
--     Instagram).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media',
  'media',
  false,
  314572800,
  array['video/mp4', 'video/quicktime', 'image/jpeg']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Aucune politique sur `storage.objects` pour ce bucket : ni lecture, ni
-- écriture pour anon/authenticated. Le serveur agit en service_role et ne
-- distribue que des URL signées à durée limitée.


-- ---------------------------------------------------------------------------
-- 2. Table media_assets
-- ---------------------------------------------------------------------------

create table if not exists public.media_assets (
  id                uuid        primary key default gen_random_uuid(),
  workspace_id      uuid        not null references public.workspaces (id) on delete cascade,
  -- Clé de l'objet dans le bucket : `<workspace_id>/<uuid>.<ext>`.
  -- JAMAIS une URL signée. Le premier segment porte l'isolation.
  storage_path      text        not null unique,
  original_filename text        not null,
  mime_type         text        not null,
  byte_size         bigint      not null,
  kind              text        not null,
  -- Caractéristiques renseignées après analyse du fichier ; null tant que le
  -- média n'a pas été inspecté.
  width             integer,
  height            integer,
  duration_seconds  numeric(10, 3),
  video_codec       text,
  -- `uploading` : URL d'upload délivrée, octets pas encore confirmés.
  -- `ready`     : fichier présent et analysé, publiable.
  -- `invalid`   : refusé à l'analyse (format, durée, dimensions...).
  status            text        not null default 'uploading',
  status_detail     text,
  uploaded_by       uuid        references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint media_assets_kind_check
    check (kind in ('video', 'image')),
  constraint media_assets_status_check
    check (status in ('uploading', 'ready', 'invalid')),
  constraint media_assets_mime_check
    check (mime_type in ('video/mp4', 'video/quicktime', 'image/jpeg')),
  constraint media_assets_size_check
    check (byte_size > 0 and byte_size <= 314572800),
  constraint media_assets_filename_length
    check (char_length(original_filename) between 1 and 255),
  -- Le chemin doit commencer par le workspace : l'isolation est structurelle,
  -- pas seulement applicative.
  constraint media_assets_path_scoped
    check (storage_path like workspace_id::text || '/%'),
  -- Un média prêt a forcément été mesuré.
  constraint media_assets_ready_shape
    check (status <> 'ready' or (kind = 'image' or duration_seconds is not null))
);

create index if not exists media_assets_workspace_created_idx
  on public.media_assets (workspace_id, created_at desc);

comment on table public.media_assets is
  'Médiathèque d''un workspace. storage_path est la CLÉ de l''objet, jamais une URL signée.';

drop trigger if exists media_assets_set_updated_at on public.media_assets;
create trigger media_assets_set_updated_at
  before update on public.media_assets
  for each row
  execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 3. RLS et privilèges
-- ---------------------------------------------------------------------------

alter table public.media_assets enable row level security;

drop policy if exists media_assets_select on public.media_assets;
create policy media_assets_select
  on public.media_assets for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_staff());

-- Aucune politique d'écriture : les Server Actions écrivent via service_role,
-- après contrôle de session, de rôle et de quota.

revoke all on public.media_assets from anon, authenticated;
grant select (id, workspace_id, storage_path, original_filename, mime_type,
              byte_size, kind, width, height, duration_seconds, video_codec,
              status, status_detail, uploaded_by, created_at, updated_at)
  on public.media_assets to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Consommation de stockage par workspace
-- ---------------------------------------------------------------------------
-- Le quota `storageGb` du plan a besoin d'un total. Une fonction plutôt qu'un
-- compteur dénormalisé : impossible à désynchroniser.

create or replace function public.workspace_storage_bytes(p_workspace_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(m.byte_size), 0)::bigint
  from public.media_assets m
  where m.workspace_id = p_workspace_id
    and m.status <> 'invalid';
$$;

revoke all on function public.workspace_storage_bytes(uuid) from public, anon;
grant execute on function public.workspace_storage_bytes(uuid) to authenticated, service_role;
