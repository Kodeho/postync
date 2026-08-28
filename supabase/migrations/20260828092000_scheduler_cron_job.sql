-- ===========================================================================
-- POSTYNC — C10.2 : le réveil, chaque minute
-- ===========================================================================
-- Le job lit ses DEUX paramètres dans Vault : l'origine à appeler et le
-- secret partagé. Rien n'est écrit en dur, et le secret n'apparaît donc ni
-- dans `cron.job`, ni dans les journaux d'exécution — ce qui compte, car
-- `cron.job.command` est lisible par quiconque peut lire ce catalogue.
--
-- `timeout_milliseconds` est relevé à 60 s : le défaut de pg_net est 2 s,
-- très en dessous de ce que peut prendre un lot de publications. Un
-- dépassement n'est de toute façon pas grave — la requête HTTP est
-- abandonnée côté base, mais la fonction serverless poursuit son travail, et
-- ce qui n'aboutit pas est repris au réveil suivant.
--
-- Changer de domaine ne demande pas de migration : il suffit de mettre à jour
-- le secret `scheduler/site_url`.
-- ===========================================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'postync-publish-scheduler') then
    perform cron.unschedule('postync-publish-scheduler');
  end if;
end
$$;

select cron.schedule(
  'postync-publish-scheduler',
  '* * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets
              where name = 'scheduler/site_url') || '/api/cron/publish',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-postync-cron', (select decrypted_secret from vault.decrypted_secrets
                           where name = 'scheduler/cron')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$
);
