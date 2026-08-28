-- C14 — operations d'appartenance, cote base.
--
-- POURQUOI EN BASE PLUTOT QUE DANS L'APPLICATION. L'autorisation reste dans
-- les Server Actions, comme partout ailleurs. Ce qui descend ici, ce sont les
-- garanties qu'aucune verification applicative ne peut tenir face a des
-- requetes concurrentes : verifier puis ecrire laisse toujours une fenetre
-- entre les deux. Les fonctions prennent donc le verrou de la ligne du
-- workspace, ce qui serialise toutes les mutations d'appartenance.

-- ---------------------------------------------------------------------------
-- Acceptation
-- ---------------------------------------------------------------------------
--
-- ACCORDEE A `authenticated`, ET C'EST VOULU. La fonction lit `auth.uid()`
-- elle-meme au lieu de recevoir un identifiant en parametre : l'appelant ne
-- peut donc pas designer quelqu'un d'autre, et un bug applicatif ne peut pas
-- rattacher la mauvaise personne. C'est structurellement impossible.
create or replace function public.accept_workspace_invitation(p_token_hash text)
returns table(status text, slug text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation public.workspace_invitations%rowtype;
  v_email      text;
  v_slug       text;
begin
  if auth.uid() is null then
    return query select 'not_authenticated'::text, null::text;
    return;
  end if;

  -- Verrou sur l'invitation : deux acceptations simultanees du meme lien
  -- (double clic, rechargement) se serialisent, et la seconde constate que
  -- c'est deja fait au lieu de creer une seconde adhesion.
  select * into v_invitation
  from public.workspace_invitations
  where token_hash = p_token_hash
  for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  if v_invitation.revoked_at is not null then
    return query select 'revoked'::text, null::text;
    return;
  end if;
  if v_invitation.accepted_at is not null then
    return query select 'already_accepted'::text, null::text;
    return;
  end if;
  if v_invitation.expires_at <= now() then
    return query select 'expired'::text, null::text;
    return;
  end if;

  select lower(email) into v_email from auth.users where id = auth.uid();

  -- LE CONTROLE CENTRAL : un lien qui fuite ne vaut rien pour quelqu'un
  -- d'autre. L'invitation est liee a UNE adresse, et seule cette adresse
  -- l'ouvre.
  if v_email is null or v_email <> v_invitation.email then
    return query select 'email_mismatch'::text, null::text;
    return;
  end if;

  select w.slug into v_slug
  from public.workspaces w
  where w.id = v_invitation.workspace_id
  for update;

  if v_slug is null then
    return query select 'workspace_gone'::text, null::text;
    return;
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_invitation.workspace_id, auth.uid(), v_invitation.role)
  on conflict (workspace_id, user_id) do nothing;

  update public.workspace_invitations
  set accepted_at = now(), accepted_by = auth.uid()
  where id = v_invitation.id;

  return query select 'accepted'::text, v_slug;
end;
$$;

revoke all on function public.accept_workspace_invitation(text) from public, anon;
grant execute on function public.accept_workspace_invitation(text) to authenticated;

comment on function public.accept_workspace_invitation(text) is
  'C14 - accepte une invitation pour l''utilisateur connecte. L''identite vient de auth.uid(), jamais d''un parametre.';
