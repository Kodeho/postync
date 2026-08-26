-- Durcissement : `public.handle_new_user()` est une fonction de TRIGGER
-- `security definer`. Elle héritait du `grant execute` par défaut de Postgres
-- vers `public`, et se retrouvait donc exposée par PostgREST sur
-- `/rest/v1/rpc/handle_new_user` aux rôles `anon` et `authenticated`
-- (advisor Supabase 0028 / 0029).
--
-- Une fonction de trigger ne peut pas être appelée directement en pratique,
-- mais aucune raison de laisser une surface `security definer` publique.
--
-- Le trigger `on_auth_user_created` n'est PAS affecté : les droits d'exécution
-- d'une fonction de trigger sont vérifiés à la création du trigger, pas à
-- chaque déclenchement.
--
-- Opération strictement non destructive : aucune donnée, aucune structure.

revoke execute on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user() from authenticated;
