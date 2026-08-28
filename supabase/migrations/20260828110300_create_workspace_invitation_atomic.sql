-- C14 — creation d'invitation atomique.
--
-- POURQUOI CETTE FONCTION EXISTE. Compter les sieges puis inserer depuis
-- l'application laisse une fenetre : deux invitations concurrentes pour DEUX
-- adresses differentes lisent toutes deux « il reste un siege » et s'inserent
-- toutes deux. L'index unique partiel ne protege que la meme adresse, donc le
-- quota du forfait serait depasse.
--
-- La correction est de serialiser sur la ligne du workspace, comme le font
-- deja `accept_workspace_invitation`, `remove_workspace_member` et
-- `set_workspace_member_role` : toutes les mutations d'appartenance et de
-- sieges passent par un unique point de serialisation.
--
-- Le quota est un PARAMETRE, pas une lecture : il vient de la resolution du
-- plan (abonnement Stripe + entitlements), qui vit cote application depuis C7.
-- Le dupliquer en SQL creerait une deuxieme verite sur le droit d'acces.
create or replace function public.create_workspace_invitation(
  p_workspace_id uuid,
  p_email        text,
  p_role         text,
  p_token_hash   text,
  p_invited_by   uuid,
  p_seat_quota   integer,
  p_expires_at   timestamptz
)
returns table(status text, invitation_id uuid, seats integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := lower(btrim(p_email));
  v_occupes  integer;
  v_id       uuid;
begin
  if p_role not in ('admin', 'member') then
    return query select 'invalid_role'::text, null::uuid, p_seat_quota;
    return;
  end if;

  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then
    return query select 'workspace_not_found'::text, null::uuid, p_seat_quota;
    return;
  end if;

  -- Deja membre : la question se pose sur l'adresse, seule chose que
  -- l'invitant connaisse.
  if exists (
    select 1
    from public.workspace_members m
    join auth.users u on u.id = m.user_id
    where m.workspace_id = p_workspace_id
      and lower(u.email) = v_email
  ) then
    return query select 'already_member'::text, null::uuid, p_seat_quota;
    return;
  end if;

  -- Sieges occupes = membres actuels + invitations encore vivantes. Compte
  -- sous verrou, donc stable jusqu'au commit.
  select
    (select count(*) from public.workspace_members
      where workspace_id = p_workspace_id)
    + (select count(*) from public.workspace_invitations
        where workspace_id = p_workspace_id
          and accepted_at is null
          and revoked_at is null
          and expires_at > now())
  into v_occupes;

  if v_occupes >= p_seat_quota then
    return query select 'seats_exhausted'::text, null::uuid, p_seat_quota;
    return;
  end if;

  begin
    insert into public.workspace_invitations
      (workspace_id, email, role, token_hash, invited_by, expires_at)
    values
      (p_workspace_id, v_email, p_role, p_token_hash, p_invited_by, p_expires_at)
    returning id into v_id;
  exception
    when unique_violation then
      -- Une invitation vivante existe deja pour cette adresse : l'index
      -- partiel reste la source de verite.
      return query select 'already_invited'::text, null::uuid, p_seat_quota;
      return;
  end;

  return query select 'created'::text, v_id, p_seat_quota;
end;
$$;

revoke all on function public.create_workspace_invitation(uuid, text, text, text, uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.create_workspace_invitation(uuid, text, text, text, uuid, integer, timestamptz) to service_role;

comment on function public.create_workspace_invitation(uuid, text, text, text, uuid, integer, timestamptz) is
  'C14 - cree une invitation sous verrou du workspace : le quota de sieges ne peut pas etre depasse par des invitations concurrentes. service_role uniquement.';
