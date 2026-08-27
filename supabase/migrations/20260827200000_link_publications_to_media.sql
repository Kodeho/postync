-- ===========================================================================
-- POSTYNC — C9.3 : relier une publication à un média de la bibliothèque
-- ===========================================================================
-- Le champ d'URL manuelle reste en place le temps que la médiathèque le
-- remplace réellement : les deux chemins coexistent, et `media_url` garde son
-- sens de « d'où vient le média ».
--
--   * chemin manuel      : media_url = URL publique fournie par l'utilisateur ;
--   * chemin médiathèque : media_url = CLÉ de l'objet dans le bucket, et
--     media_asset_id pointe la ligne correspondante.
--
-- Dans les deux cas, media_url ne contient JAMAIS d'URL signée : celle-ci est
-- forgée au moment de publier et n'est pas conservée.
-- ===========================================================================

alter table public.social_publications
  add column if not exists media_asset_id uuid
  references public.media_assets (id) on delete set null;

comment on column public.social_publications.media_asset_id is
  'Média de la bibliothèque publié. Null pour le chemin historique par URL manuelle.';

create index if not exists social_publications_media_asset_idx
  on public.social_publications (media_asset_id)
  where media_asset_id is not null;

grant select (media_asset_id) on public.social_publications to authenticated;
