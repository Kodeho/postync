-- Durcissement de `disconnect_social_account`.
--
-- La première version est DÉJÀ APPLIQUÉE : elle ne peut plus être modifiée en
-- place sans divergence entre les environnements. Ce fichier est donc une
-- migration corrective distincte, et non une réécriture de la précédente.
--
-- L'audit des privilèges réellement déployés donnait :
--
--   securite    = DEFINER
--   proprietaire= postgres
--   search_path = public
--   privileges  = postgres=X/postgres | service_role=X/postgres
--
-- Aucun droit superflu n'était donc accordé — ni `public`, ni `anon`, ni
-- `authenticated`. Deux points restaient néanmoins à durcir.

-- ---------------------------------------------------------------------------
-- 1. `search_path` vide plutôt que `public`
-- ---------------------------------------------------------------------------
--
-- Une fonction `security definer` s'exécute avec les droits de son
-- propriétaire — ici `postgres`. Laisser `public` dans son chemin de recherche
-- signifie qu'un objet créé dans ce schéma peut, en théorie, masquer celui que
-- la fonction croit appeler. Le corps qualifie déjà tout (`public.<table>`), le
-- chemin peut donc être VIDE : plus rien n'est résolu implicitement.
--
-- ---------------------------------------------------------------------------
-- 2. Validation explicite des arguments
-- ---------------------------------------------------------------------------
--
-- La version précédente filtrait correctement sur `workspace_id` — un compte
-- d'un autre workspace ne pouvait donc rien purger. Mais elle le faisait en
-- SILENCE : un identifiant inconnu, un workspace qui ne correspond pas, ou un
-- argument null rendaient simplement (0, 0), et l'appelant lisait un succès.
--
-- L'appelant applicatif vérifie déjà l'appartenance avant d'appeler. Ce
-- contrôle est donc une SECONDE barrière, et elle doit être bruyante : une
-- déconnexion qui ne déconnecte rien est une anomalie, pas un cas nominal.
create or replace function public.disconnect_social_account(
  p_account_id   uuid,
  p_workspace_id uuid
)
returns table (cancelled integer, purged integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cancelled integer := 0;
  v_purged    integer := 0;
begin
  if p_account_id is null or p_workspace_id is null then
    raise exception 'disconnect_social_account: arguments obligatoires'
      using errcode = '22004';
  end if;

  -- Le compte doit exister ET appartenir à CE workspace. Le verrou empêche une
  -- déconnexion concurrente de passer entre la vérification et la suppression.
  perform 1
     from public.social_accounts
    where id = p_account_id
      and workspace_id = p_workspace_id
    for update;
  if not found then
    raise exception 'disconnect_social_account: compte introuvable dans ce workspace'
      using errcode = 'P0002';
  end if;

  -- a. Ce qui était en cours ne repartira jamais : le jeton n'existera plus.
  update public.social_publications
     set status = 'failed',
         status_detail = 'account_disconnected'
   where social_account_id = p_account_id
     and workspace_id = p_workspace_id
     and status in ('pending', 'scheduled');
  get diagnostics v_cancelled = row_count;

  -- b. Purge des données issues de la plateforme.
  update public.social_publications
     set provider_account_id = null,
         provider_media_id   = null,
         permalink           = null,
         container_id        = null,
         purged_at           = now()
   where social_account_id = p_account_id
     and workspace_id = p_workspace_id;
  get diagnostics v_purged = row_count;

  -- c. Suppression du compte. Le trigger `social_accounts_purge_secrets`
  --    détruit les secrets du coffre dans la MÊME transaction.
  delete from public.social_accounts
   where id = p_account_id
     and workspace_id = p_workspace_id;

  return query select v_cancelled, v_purged;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Privilèges — réaffirmés
-- ---------------------------------------------------------------------------
--
-- `create or replace` conserve les privilèges existants, mais les réaffirmer
-- coûte une ligne et vaut mieux qu'un raisonnement : ces droits sont la seule
-- chose qui sépare cette fonction d'une purge déclenchable par un client.
revoke all on function public.disconnect_social_account(uuid, uuid) from public;
revoke all on function public.disconnect_social_account(uuid, uuid) from anon;
revoke all on function public.disconnect_social_account(uuid, uuid) from authenticated;
grant execute on function public.disconnect_social_account(uuid, uuid) to service_role;

comment on function public.disconnect_social_account(uuid, uuid) is
  'Déconnexion atomique : annule les publications en cours, purge les données de plateforme, supprime le compte (et ses secrets). Lève si le compte n''appartient pas au workspace. service_role uniquement.';
