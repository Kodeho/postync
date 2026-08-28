-- C14 — role et retrait d'un membre, alignes sur le modele de propriete reel.
--
-- CE QUI EXISTE DEPUIS C4. Le declencheur `protect_owner_membership` impose,
-- ligne par ligne, qu'un workspace ait EXACTEMENT un proprietaire, et que ce
-- soit `workspaces.owner_id` :
--   * l'appartenance du proprietaire ne peut pas etre supprimee ;
--   * son role ne peut pas changer ;
--   * personne d'autre ne peut porter le role `owner`.
--
-- L'invariant « jamais de workspace sans proprietaire » est donc deja garanti
-- sans verrou ni comptage : chaque ligne est protegee individuellement, il n'y
-- a aucune fenetre entre une verification et une ecriture.
--
-- CE QUE CETTE MIGRATION CORRIGE. Les premieres versions de ces fonctions
-- comptaient les proprietaires, comme s'il pouvait y en avoir plusieurs, et
-- laissaient le declencheur lever une exception quand on tentait d'en nommer
-- un second : la Server Action recevait une erreur brute et affichait
-- « Reessayez », ce qui invite a recommencer une operation qui ne reussira
-- jamais. Elles rendent desormais un verdict explicite.
--
-- Le transfert de propriete est une operation distincte — il faut deplacer
-- `workspaces.owner_id` — volontairement hors de C14.
create or replace function public.set_workspace_member_role(
  p_workspace_id uuid,
  p_user_id      uuid,
  p_role         text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ancien   text;
  v_owner_id uuid;
begin
  -- `owner` n'est pas un role attribuable : il suit `workspaces.owner_id`.
  if p_role not in ('admin', 'member') then
    return case when p_role = 'owner' then 'owner_is_unique' else 'invalid_role' end;
  end if;

  select owner_id into v_owner_id
  from public.workspaces
  where id = p_workspace_id
  for update;

  if v_owner_id is null then
    return 'workspace_not_found';
  end if;

  -- Le proprietaire garde son role tant qu'il est proprietaire.
  if p_user_id = v_owner_id then
    return 'is_owner';
  end if;

  select role into v_ancien
  from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id;

  if v_ancien is null then
    return 'member_not_found';
  end if;
  if v_ancien = p_role then
    return 'unchanged';
  end if;

  update public.workspace_members
  set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id;

  return 'updated';
end;
$$;

create or replace function public.remove_workspace_member(
  p_workspace_id uuid,
  p_user_id      uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role     text;
  v_owner_id uuid;
begin
  select owner_id into v_owner_id
  from public.workspaces
  where id = p_workspace_id
  for update;

  if v_owner_id is null then
    return 'workspace_not_found';
  end if;

  if p_user_id = v_owner_id then
    return 'is_owner';
  end if;

  select role into v_role
  from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id;

  if v_role is null then
    return 'member_not_found';
  end if;

  delete from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id;

  return 'removed';
end;
$$;

-- service_role uniquement : l'autorisation d'agir (owner ou admin, et sur qui)
-- est decidee par la Server Action, comme partout ailleurs dans le produit.
revoke all on function public.set_workspace_member_role(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.remove_workspace_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_workspace_member_role(uuid, uuid, text) to service_role;
grant execute on function public.remove_workspace_member(uuid, uuid) to service_role;

comment on function public.set_workspace_member_role(uuid, uuid, text) is
  'C14 - change le role d''un membre. `owner` n''est pas attribuable : il suit workspaces.owner_id, garanti par protect_owner_membership. service_role uniquement.';
comment on function public.remove_workspace_member(uuid, uuid) is
  'C14 - retire un membre. Le proprietaire ne peut pas etre retire : le workspace resterait sans administrateur. service_role uniquement.';
