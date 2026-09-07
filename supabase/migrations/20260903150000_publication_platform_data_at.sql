-- ===========================================================================
-- POSTYNC — dater l'ACQUISITION des données de plateforme
-- ===========================================================================
-- MIGRATION DISTINCTE, et non réécriture de `20260903090000` : celle-ci est
-- déjà appliquée au staging. Réécrire une migration appliquée ferait diverger
-- les environnements sans que rien ne le signale.
--
-- ---------------------------------------------------------------------------
-- POURQUOI `updated_at` NE POUVAIT PAS FAIRE L'AFFAIRE
-- ---------------------------------------------------------------------------
-- La purge des données de plateforme se datait sur `updated_at`. Or un trigger
-- le remonte à CHAQUE écriture sur la ligne, quelle qu'en soit la raison. Une
-- correction de légende, un changement de statut, n'importe quelle évolution
-- future touchant la ligne repousserait l'échéance des 30 jours — et la donnée
-- serait conservée AU-DELÀ de 30 jours après son obtention, ce que les
-- Developer Policies III.E.4.c interdisent.
--
-- `created_at` ne convenait pas davantage, en sens inverse : une publication
-- programmée peut être créée jusqu'à 364 jours avant son envoi. Dater depuis
-- la création purgerait des données obtenues la veille.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE COLONNE EST
-- ---------------------------------------------------------------------------
-- L'instant où la donnée de plateforme a été OBTENUE. Elle n'est écrite qu'aux
-- deux endroits qui en acquièrent une :
--
--   * ouverture du conteneur — `container_id`, l'URI de session résumable ;
--   * publication réussie    — `provider_media_id` et `permalink`, écrits dans
--     la même instruction que `published_at`. Pour une publication réussie,
--     les deux valeurs coïncident donc, et c'est voulu : `published_at` EST
--     l'instant d'acquisition, vérifié dans `publish.ts`.
--
-- Rien d'autre n'y touche. Aucun trigger, aucune mise à jour de confort. Une
-- modification sans rapport avec YouTube ne peut pas repousser l'échéance.
--
-- ---------------------------------------------------------------------------
-- BACKFILL
-- ---------------------------------------------------------------------------
-- Pour les lignes existantes, `published_at` quand il existe — c'est la valeur
-- exacte —, sinon `created_at`. Ce repli est CONSERVATEUR : `created_at` est
-- antérieur ou égal à l'acquisition, donc l'échéance tombe au plus tôt, jamais
-- au plus tard. Se tromper dans ce sens fait perdre un lien d'historique ; se
-- tromper dans l'autre serait un manquement.
--
-- Les lignes sans aucune donnée de plateforme restent NULLES : il n'y a rien à
-- purger, et la requête de rétention les ignore.
-- ===========================================================================

alter table public.social_publications
  add column if not exists platform_data_at timestamptz;

update public.social_publications
   set platform_data_at = coalesce(published_at, created_at)
 where platform_data_at is null
   and (provider_media_id is not null
        or permalink is not null
        or container_id is not null);

comment on column public.social_publications.platform_data_at is
  'Instant d''OBTENTION des données de plateforme (conteneur, identifiant de vidéo, permalien). Écrit uniquement à l''acquisition, jamais remonté par une écriture sans rapport. Null si la ligne n''en porte aucune.';

-- La passe de rétention ne lit que des lignes terminales portant une donnée de
-- plateforme non encore purgée : l'index partiel suit exactement ce filtre.
create index if not exists social_publications_retention_idx
  on public.social_publications (platform_data_at)
  where platform_data_at is not null and purged_at is null;

grant select (platform_data_at) on public.social_publications to authenticated;
