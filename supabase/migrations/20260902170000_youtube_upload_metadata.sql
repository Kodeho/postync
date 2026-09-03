-- ===========================================================================
-- POSTYNC — métadonnées d'upload YouTube exigées par la conformité
-- ===========================================================================
-- Trois documents officiels imposent ce que cette migration rend stockable :
--
--   * Required Minimum Functionality, « Uploading videos → Data requirements » :
--     « Users must be able to choose whether the uploaded video will be public,
--     private, or unlisted. » Le choix doit donc exister ET survivre à une
--     programmation, sinon il n'est pas celui de l'utilisateur.
--   * Developer Policies III.J : une vidéo destinée aux enfants DOIT être
--     déclarée `selfDeclaredMadeForKids = true`. Cette déclaration engage
--     l'utilisateur au titre de la COPPA : l'application ne peut pas la faire
--     à sa place, ni la deviner.
--   * Community Guidelines : la certification est demandée à la saisie ; on en
--     garde l'horodatage, faute de quoi elle ne prouve rien.
--
-- Jusqu'ici le titre n'était même pas conservé : `schedulePublication`
-- l'ignorait, et une publication YouTube programmée échouait à l'exécution sur
-- `title_required`. La colonne `title` corrige ce défaut, pas seulement la
-- conformité.
--
-- ---------------------------------------------------------------------------
-- POURQUOI TOUT EST NULLABLE, ET POURQUOI LA CONTRAINTE DE FORME N'EST PAS ICI
-- ---------------------------------------------------------------------------
--
-- Deux populations de lignes existent déjà et ne peuvent pas porter ces
-- valeurs : les publications des trois autres réseaux, à qui ces notions ne
-- s'appliquent pas, et les publications YouTube antérieures à cette migration.
-- Aucune colonne n'est donc `not null`, et aucun défaut n'est posé : un défaut
-- ferait croire à un choix que personne n'a fait.
--
-- La contrainte « une publication YouTube porte ces quatre valeurs » n'est PAS
-- créée ici, même en `not valid`. Une contrainte `not valid` n'inspecte pas
-- l'existant, mais elle s'applique bel et bien aux INSERT : posée avant que le
-- nouveau code ne soit déployé partout, elle ferait échouer les insertions de
-- l'ancien, qui ne renseigne aucune de ces colonnes. Or une migration
-- s'applique hors du déploiement applicatif, donc nécessairement dans un ordre
-- qu'on ne maîtrise pas complètement.
--
-- Phase 1 — celle-ci : les colonnes existent, l'exigence est portée par la
--           validation serveur (`src/lib/youtube-metadata.ts`, appelée par
--           `publish.ts` et `schedule.ts`). L'ancien code continue de
--           fonctionner à l'identique.
-- Phase 2 — migration ultérieure, une fois le nouveau code déployé partout :
--
--     alter table public.social_publications
--       add constraint social_publications_youtube_metadata
--       check (
--         platform <> 'youtube'
--         or (title is not null and privacy_status is not null
--             and made_for_kids is not null
--             and guidelines_acknowledged_at is not null)
--       ) not valid;
--
--           puis, après reprise ou acceptation des lignes historiques :
--
--     alter table public.social_publications
--       validate constraint social_publications_youtube_metadata;
--
--           `validate` ne prend qu'un verrou SHARE UPDATE EXCLUSIVE : il ne
--           bloque ni les lectures ni les écritures.
--
-- Les contraintes posées ci-dessous, elles, sont vraies pour `null` : elles ne
-- peuvent donc rien casser, ni sur l'existant ni sur l'ancien code.
-- ===========================================================================

alter table public.social_publications
  add column if not exists title                      text,
  add column if not exists privacy_status             text,
  add column if not exists made_for_kids              boolean,
  add column if not exists guidelines_acknowledged_at timestamptz;


-- `snippet.title` : YouTube refuse au-delà de 100 caractères. On préfère un
-- refus net ici plutôt qu'un aller-retour perdu jusqu'à Google.
alter table public.social_publications
  drop constraint if exists social_publications_title_length;
alter table public.social_publications
  add constraint social_publications_title_length
  check (title is null or char_length(title) <= 100);

-- Le vocabulaire est celui de `status.privacyStatus` chez YouTube. Les trois
-- valeurs sont celles que la RMF impose d'offrir.
alter table public.social_publications
  drop constraint if exists social_publications_privacy_status_check;
alter table public.social_publications
  add constraint social_publications_privacy_status_check
  check (privacy_status is null or privacy_status in ('public', 'private', 'unlisted'));


comment on column public.social_publications.title is
  'Titre du média (YouTube `snippet.title`). Null pour les réseaux sans notion de titre.';
comment on column public.social_publications.privacy_status is
  'Visibilité demandée par l''utilisateur : public, private ou unlisted. Null hors YouTube.';
comment on column public.social_publications.made_for_kids is
  'Déclaration `selfDeclaredMadeForKids` faite par l''utilisateur. Jamais devinée. Null hors YouTube.';
comment on column public.social_publications.guidelines_acknowledged_at is
  'Horodatage de la certification « contenu conforme aux YouTube Community Guidelines ». Null hors YouTube.';


-- Lecture navigateur : mêmes règles que les colonnes existantes, colonne par
-- colonne. `guidelines_acknowledged_at` reste hors liste — c'est une trace,
-- l'interface n'en a pas l'usage.
grant select (title, privacy_status, made_for_kids)
  on public.social_publications to authenticated;
