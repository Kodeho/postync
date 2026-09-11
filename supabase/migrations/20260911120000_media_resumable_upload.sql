-- ===========================================================================
-- POSTYNC — téléversement REPRENABLE (TUS) de la médiathèque
-- ===========================================================================
-- POURQUOI CETTE MIGRATION EXISTE
--
-- Jusqu'ici le bucket `media` n'avait AUCUNE politique : le serveur signait
-- une URL d'upload en `service_role` et le navigateur y déposait le fichier
-- d'un seul `PUT`. Ce mode a deux défauts pour une vidéo :
--
--   * il n'est pas reprenable — une coupure réseau à 90 % renvoie à zéro ;
--   * l'URL signée est à usage unique, donc un échec impose de redemander un
--     ticket, et le fichier repart du premier octet.
--
-- Le protocole TUS de Supabase corrige les deux, mais il n'accepte PAS d'URL
-- signée : son endpoint `/storage/v1/upload/resumable` s'authentifie avec le
-- JWT de l'utilisateur et passe donc par RLS. Il faut, et il suffit, d'une
-- politique `INSERT` sur `storage.objects`.
--
-- CE QUE CETTE POLITIQUE N'OUVRE PAS
--
-- `INSERT` seulement. Pas de `select`, pas de `update`, pas de `delete` :
--   * la LECTURE reste impossible pour `authenticated` — les aperçus et les
--     URL remises aux plateformes continuent d'être signés par le serveur,
--     à durée courte (cf. 20260827180000, principe 2) ;
--   * l'ÉCRASEMENT reste impossible : sans `select` ni `update`, `x-upsert`
--     ne peut pas aboutir. Un chemin déjà pris est refusé, jamais remplacé ;
--   * la SUPPRESSION reste réservée au serveur.
--
-- CE QU'ELLE BORNE
--
-- Le premier segment du chemin est l'identifiant du workspace — c'était déjà
-- l'invariant du schéma (« l'isolation est structurelle »). La politique le
-- vérifie, et exige en plus le rôle `owner` ou `admin` : exactement le même
-- contrôle que `requireMediaManager` côté serveur. Un membre simple ne peut
-- rien déposer, et personne ne peut écrire hors de son workspace.
--
-- CE QUI RESTE VÉRIFIÉ PAR LE SERVEUR, ET NE DOIT PAS L'ÊTRE ICI
--
-- Le quota du plan, le type MIME, la taille annoncée et l'unicité du chemin
-- sont contrôlés par `requestUpload` AVANT que le navigateur ne reçoive le
-- chemin à écrire. Le nom d'objet étant un UUID tiré par le serveur, un
-- client ne peut pas deviner un chemin qui lui serait utile : au pire il
-- écrit un objet orphelin dans son propre workspace, qu'aucune ligne
-- `media_assets` ne référence, que le serveur ne servira jamais, et que le
-- nettoyage des dépôts abandonnés (§3) finit par retirer.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Rôle du workspace à partir d'un segment de chemin
-- ---------------------------------------------------------------------------
-- `((storage.foldername(name))[1])::uuid` LÈVERAIT une erreur — et non un
-- refus — si le premier segment n'était pas un uuid, et une erreur dans une
-- politique remonte au client en 500. Cette enveloppe absorbe le cas et
-- renvoie `null`, ce qui fait simplement échouer la politique.

create or replace function public.workspace_role_by_text(p_workspace text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  begin
    v_id := p_workspace::uuid;
  exception when others then
    return null;
  end;
  return public.workspace_role(v_id);
end;
$$;

revoke all on function public.workspace_role_by_text(text) from public, anon;
grant execute on function public.workspace_role_by_text(text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. Dépôt reprenable, borné au workspace de l'utilisateur
-- ---------------------------------------------------------------------------

drop policy if exists media_resumable_insert on storage.objects;
create policy media_resumable_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    -- Le chemin doit être `<workspace_id>/<uuid>.<ext>` : exactement un
    -- dossier, donc jamais un dépôt à la racine ni une arborescence libre.
    and array_length(storage.foldername(name), 1) = 1
    and public.workspace_role_by_text((storage.foldername(name))[1])
        in ('owner', 'admin')
  );

comment on policy media_resumable_insert on storage.objects is
  'Televersement TUS : INSERT seul, dans le workspace de l''utilisateur, pour owner/admin. Aucune lecture ni ecrasement.';


-- ---------------------------------------------------------------------------
-- 3. Nettoyage des dépôts abandonnés
-- ---------------------------------------------------------------------------
-- Un téléversement interrompu laisse deux traces : une ligne `media_assets`
-- restée en `uploading`, et parfois un objet partiel côté stockage. Ni l'une
-- ni l'autre n'est publiable, mais la ligne compte dans le quota tant qu'elle
-- existe — ce serait une facture pour du vide.
--
-- La fonction ne touche QUE des lignes `uploading` plus vieilles que le délai,
-- jamais un média `ready`. Deux heures : largement au-delà d'un transfert de
-- 300 Mo, y compris en reprise, et bien en-deçà d'une gêne pour l'utilisateur.

create or replace function public.purge_stale_media_uploads(p_older_than interval default interval '2 hours')
returns table (purged_id uuid, storage_path text)
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.media_assets m
   where m.status = 'uploading'
     and m.created_at < now() - p_older_than
  returning m.id, m.storage_path;
$$;

revoke all on function public.purge_stale_media_uploads(interval) from public, anon, authenticated;
grant execute on function public.purge_stale_media_uploads(interval) to service_role;

comment on function public.purge_stale_media_uploads(interval) is
  'Retire les reservations de televersement jamais confirmees. Renvoie les chemins a supprimer du bucket. service_role uniquement.';
