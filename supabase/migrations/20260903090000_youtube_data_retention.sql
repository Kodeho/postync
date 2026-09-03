-- ===========================================================================
-- POSTYNC — rétention et révocation des données de chaîne (Developer Policies)
-- ===========================================================================
-- Trois obligations, avec des délais DIFFÉRENTS qu'il faut cesser de
-- confondre :
--
--   III.E.4.c — les données autorisées autres que les jetons et les
--     statistiques ne peuvent être conservées « for no longer than 30
--     calendar days. After 30 calendar days, the API Client must either
--     delete or refresh the stored data ». L'identité de chaîne
--     (`provider_account_id`, `display_name`, `avatar_url`) relève de cette
--     règle : elle est lue une fois à la connexion et n'a jamais été relue.
--
--   III.D.2 — après révocation par NOTRE mécanisme, suppression « within 7
--     calendar days ». POSTYNC le tient déjà : `disconnect_social_account`
--     purge dans la transaction du clic. Après révocation depuis les
--     paramètres Google, le délai est de « 30 calendar days » — et là, rien
--     ne le détectait.
--
--   III.D.2 encore — l'API Client « will need to periodically reconfirm that
--     its authorization tokens are still valid and delete API Data associated
--     with users whose authorization tokens cannot be refreshed ». C'est une
--     obligation ACTIVE : attendre la prochaine publication ne suffit pas,
--     un compte inactif ne serait jamais réexaminé.
--
-- Une seule passe périodique satisfait les trois : elle rafraîchit l'identité
-- (donc remet le compteur des 30 jours à zéro) et, ce faisant, reconfirme le
-- jeton (donc détecte la révocation). Les deux colonnes ci-dessous lui
-- servent de mémoire.
--
-- ---------------------------------------------------------------------------
-- COMPATIBILITÉ AVEC L'ANCIEN CODE
-- ---------------------------------------------------------------------------
-- `identity_refreshed_at` est NULLABLE et `identity_refresh_failures` porte un
-- défaut : l'ancien code, qui ne les renseigne pas, continue d'insérer et de
-- mettre à jour à l'identique. Aucune contrainte de forme n'est ajoutée.
--
-- Le backfill est délibéré et honnête : l'identité d'une ligne existante a
-- réellement été lue à `connected_at`. La dater d'aujourd'hui masquerait son
-- ancienneté ; la laisser nulle la ferait passer pour périmée dès la première
-- passe, et purgerait des comptes valides.
-- ===========================================================================

alter table public.social_accounts
  add column if not exists identity_refreshed_at    timestamptz,
  add column if not exists identity_refresh_failures smallint not null default 0;

update public.social_accounts
   set identity_refreshed_at = connected_at
 where identity_refreshed_at is null;

comment on column public.social_accounts.identity_refreshed_at is
  'Dernière relecture de l''identité de chaîne auprès de la plateforme. Sert le plafond de 30 jours des Developer Policies III.E.4.c.';
comment on column public.social_accounts.identity_refresh_failures is
  'Échecs PASSAGERS consécutifs de la relecture. Une révocation confirmée ne passe pas par ce compteur : elle purge immédiatement.';

-- Les passes n'examinent que les lignes les plus anciennes : index sur la
-- fraîcheur, restreint aux comptes encore actifs.
create index if not exists social_accounts_identity_staleness_idx
  on public.social_accounts (identity_refreshed_at nulls first)
  where status = 'active';

grant select (identity_refreshed_at) on public.social_accounts to authenticated;


-- ---------------------------------------------------------------------------
-- Job pg_cron — CRÉÉ DÉSACTIVÉ
-- ---------------------------------------------------------------------------
-- Il est posé pour que sa définition vive avec la migration et non dans une
-- console, mais il ne tourne pas : l'activer est une décision distincte, qui
-- se prend une fois le code déployé et l'endpoint vérifié.
--
--   select cron.alter_job(
--     (select jobid from cron.job where jobname = 'postync-youtube-retention'),
--     active := true);
--
-- Cadence QUOTIDIENNE, pas mensuelle. Le plafond réglementaire est de 30
-- jours ; relire tous les 7 jours avec une passe quotidienne laisse plus de
-- trois semaines de marge pour absorber une panne de la plateforme sans
-- jamais franchir la limite. Une passe mensuelle n'aurait aucune marge.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'postync-youtube-retention') then
    perform cron.unschedule('postync-youtube-retention');
  end if;
end
$$;

select cron.schedule(
  'postync-youtube-retention',
  '17 4 * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets
              where name = 'scheduler/site_url') || '/api/cron/retention',
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

-- DÉSACTIVÉ à la création. Rien ne s'exécutera tant que personne ne l'aura
-- décidé explicitement.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'postync-youtube-retention'),
  active := false
);
