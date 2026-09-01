-- Retire `DELETE` à `service_role` sur `legal_acceptances`.
--
-- La migration précédente accordait `select, insert, delete`. Le `DELETE`
-- répondait à une intention correcte — permettre l'effacement RGPD — mais il
-- n'était nécessaire à RIEN : le code applicatif ne supprime jamais de ligne,
-- et la seule disparition légitime d'une acceptation est la cascade sur
-- suppression du compte.
--
-- POURQUOI LA CASCADE N'A PAS BESOIN DE CE DROIT, et c'est tout le point :
-- `on delete cascade` est exécutée par le MOTEUR, au nom du propriétaire de la
-- contrainte, pas au nom du rôle qui a lancé la suppression. Supprimer un
-- utilisateur emporte donc toujours ses acceptations, même sans aucun
-- privilège `DELETE` accordé à qui que ce soit sur la table.
--
-- Ce qui reste après cette migration :
--
--   anon, public  : aucun droit
--   authenticated : SELECT, et RLS le limite à ses propres lignes
--   service_role  : SELECT, INSERT
--
-- Aucun rôle applicatif ne peut donc ni réécrire ni supprimer une preuve
-- d'acceptation. C'est la seule forme sous laquelle elle en est une.
--
-- La migration `20260901140000` n'est PAS réécrite : elle est déjà appliquée,
-- et la corriger en place ferait diverger le fichier de ce qui a réellement
-- été exécuté. Cette migration-ci est la trace du changement.

revoke delete on table public.legal_acceptances from service_role;

-- Réaffirmation de l'état voulu. `revoke` puis `grant` explicites : la lecture
-- de ce fichier suffit à connaître les droits, sans avoir à remonter la
-- chaîne des migrations.
revoke all on table public.legal_acceptances from public, anon, authenticated;
grant select on table public.legal_acceptances to authenticated;
grant select, insert on table public.legal_acceptances to service_role;
