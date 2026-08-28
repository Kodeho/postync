-- C14 — lectures d'equipe.
--
-- `auth.users` n'est pas lisible depuis une session applicative : sans ces
-- fonctions, l'ecran Equipe ne pourrait afficher que des identifiants, ce qui
-- ne dit a personne AVEC QUI il partage son workspace.
--
-- La barriere reste la meme qu'ailleurs : `is_workspace_member`, l'aide deja
-- utilisee par toutes les politiques RLS depuis C4. Aucune seconde logique
-- d'autorisation n'est introduite.

create or replace function public.workspace_members_detailed(p_workspace_id uuid)
returns table(
  user_id      uuid,
  role         text,
  created_at   timestamptz,
  display_name text,
  email        text
)
language sql
security definer
set search_path = public
as $$
  select m.user_id,
         m.role,
         m.created_at,
         p.display_name,
         u.email::text
  from public.workspace_members m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.workspace_id = p_workspace_id
    and (public.is_workspace_member(p_workspace_id) or public.is_platform_staff())
  order by
    case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
    m.created_at;
$$;

revoke all on function public.workspace_members_detailed(uuid) from public, anon;
grant execute on function public.workspace_members_detailed(uuid) to authenticated;

-- Repond a « cette ADRESSE est-elle deja membre ? ». L'invitant ne connait que
-- l'adresse, jamais l'identifiant. Reservee au service : elle revelerait
-- sinon l'appartenance d'une adresse a un workspace tiers.
create or replace function public.workspace_member_id_by_email(
  p_workspace_id uuid,
  p_email        text
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select m.user_id
  from public.workspace_members m
  join auth.users u on u.id = m.user_id
  where m.workspace_id = p_workspace_id
    and lower(u.email) = lower(btrim(p_email))
  limit 1;
$$;

revoke all on function public.workspace_member_id_by_email(uuid, text) from public, anon, authenticated;
grant execute on function public.workspace_member_id_by_email(uuid, text) to service_role;

comment on function public.workspace_members_detailed(uuid) is
  'C14 - membres d''un workspace avec nom et adresse. Reservee a ses membres via is_workspace_member.';
comment on function public.workspace_member_id_by_email(uuid, text) is
  'C14 - resout une adresse en membre du workspace. service_role uniquement : revelerait sinon une appartenance.';
