-- C14 — invitations d'equipe.
--
-- LE JETON N'EST JAMAIS STOCKE. La table ne garde que son empreinte SHA-256,
-- comme `oauth_states` en C8.1. Lire la table ne permet donc de rejoindre
-- aucun workspace, et POSTYNC lui-meme ne peut pas regenerer un lien deja
-- emis : renvoyer une invitation, c'est en creer une nouvelle.
--
-- L'INVITATION EST LIEE A UNE ADRESSE. C'est cette adresse, comparee en base
-- a celle du compte connecte, qui autorise l'acceptation — pas la possession
-- du lien. Un lien transmis par erreur a un tiers ne lui ouvre rien.

create table if not exists public.workspace_invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email        text not null,
  role         text not null,
  token_hash   text not null,
  invited_by   uuid references auth.users(id) on delete set null,
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id) on delete set null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- `owner` est absent : la propriete suit `workspaces.owner_id` et ne
  -- s'attribue pas par invitation.
  constraint workspace_invitations_role_check
    check (role in ('admin', 'member')),

  -- L'adresse est stockee normalisee. Sans cela, « Jean@Exemple.fr » et
  -- « jean@exemple.fr » creeraient deux invitations dont une seule pourrait
  -- etre acceptee, et l'unicite ci-dessous ne vaudrait rien.
  constraint workspace_invitations_email_normalized
    check (email = lower(btrim(email)) and email like '%_@_%.%'),

  constraint workspace_invitations_ttl
    check (expires_at > created_at),

  -- Une invitation acceptee sait toujours PAR QUI.
  constraint workspace_invitations_accepted_shape
    check (accepted_at is null or accepted_by is not null)
);

-- Une seule invitation VIVANTE par adresse et par workspace. L'index partiel
-- est la source de verite : deux invitations simultanees pour la meme adresse
-- ne peuvent pas coexister, meme envoyees au meme instant.
create unique index if not exists workspace_invitations_live_idx
  on public.workspace_invitations (workspace_id, email)
  where accepted_at is null and revoked_at is null;

create unique index if not exists workspace_invitations_token_idx
  on public.workspace_invitations (token_hash);

create index if not exists workspace_invitations_workspace_idx
  on public.workspace_invitations (workspace_id, created_at desc);

drop trigger if exists workspace_invitations_set_updated_at on public.workspace_invitations;
create trigger workspace_invitations_set_updated_at
  before update on public.workspace_invitations
  for each row execute function public.set_updated_at();

alter table public.workspace_invitations enable row level security;

-- Les membres du workspace voient ses invitations ; personne d'autre.
drop policy if exists workspace_invitations_select on public.workspace_invitations;
create policy workspace_invitations_select
  on public.workspace_invitations
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_staff());

-- LISTE BLANCHE DE COLONNES. `token_hash` n'est accorde a personne : meme un
-- membre legitime du workspace ne peut pas le lire, donc une session
-- compromise ne permet pas de fabriquer un lien d'invitation valide. Les
-- ecritures passent exclusivement par les fonctions `security definer`.
revoke all on public.workspace_invitations from anon, authenticated;
grant select (
  id, workspace_id, email, role, invited_by,
  expires_at, accepted_at, accepted_by, revoked_at, created_at, updated_at
) on public.workspace_invitations to authenticated;

comment on table public.workspace_invitations is
  'C14 - invitations d''equipe. Seule l''empreinte du jeton est stockee ; token_hash n''est accorde a aucune session.';
comment on column public.workspace_invitations.token_hash is
  'SHA-256 du jeton. Le jeton lui-meme n''existe que dans le lien remis a l''invite.';
