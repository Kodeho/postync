-- ===========================================================================
-- POSTYNC — C13 : fuseau horaire du workspace
-- ===========================================================================
-- Le fuseau existait déjà, mais CODÉ EN DUR dans deux pages — le calendrier et
-- la vue d'ensemble — pendant que la saisie d'échéance, elle, convertissait
-- depuis le fuseau du NAVIGATEUR. Un client hors de France programmait donc à
-- une heure et la voyait affichée à une autre, sans qu'aucune erreur ne soit
-- levée nulle part.
--
-- Le fuseau appartient au WORKSPACE, pas à l'utilisateur : une équipe qui
-- publie pour une marque française doit voir les mêmes heures, quel que soit
-- l'endroit d'où chacun travaille. C'est aussi ainsi que raisonnent les outils
-- de programmation.
-- ===========================================================================

alter table public.workspaces
  add column if not exists time_zone text not null default 'Europe/Paris';

comment on column public.workspaces.time_zone is
  'Fuseau IANA du workspace. Sert a l''affichage du calendrier et de la vue d''ensemble, et a la saisie des echeances.';

-- Un CHECK ne peut pas interroger `pg_timezone_names` : les sous-requêtes y
-- sont interdites, et la liste n'est de toute façon pas immuable — elle suit
-- les mises à jour de la base de fuseaux. Un trigger valide donc à l'écriture.
--
-- Ce contrôle n'est pas cosmétique : accepter « Europe/Pariss » produirait un
-- calendrier silencieusement décalé, sans la moindre erreur visible.
create or replace function public.workspaces_check_time_zone()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.time_zone) then
    raise exception 'fuseau horaire inconnu: %', new.time_zone
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists workspaces_time_zone_known on public.workspaces;
create trigger workspaces_time_zone_known
  before insert or update of time_zone on public.workspaces
  for each row
  execute function public.workspaces_check_time_zone();

-- Lecture pour tous les membres ; écriture soumise à la politique
-- `workspaces_update_owner_admin` déjà en place. Le privilège de colonne
-- reste la liste blanche : `slug` et `owner_id` demeurent non modifiables.
grant select (time_zone) on public.workspaces to authenticated;
grant update (time_zone) on public.workspaces to authenticated;
