-- ===========================================================================
-- POSTYNC — C10.2 : de quoi réveiller le planificateur
-- ===========================================================================
-- Le plan Vercel du projet est Hobby, où les crons sont limités à UNE
-- exécution par jour : inutilisable pour un planificateur à la minute. C'est
-- donc la base qui se réveille elle-même, et qui appelle POSTYNC.
--
--   * pg_cron  : l'ordonnanceur, dans le schéma `cron` ;
--   * pg_net   : l'appel HTTP asynchrone, dans le schéma `net`.
-- ===========================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
