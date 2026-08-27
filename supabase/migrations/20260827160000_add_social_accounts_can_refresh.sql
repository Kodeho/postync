-- ===========================================================================
-- POSTYNC — C8.5 : signal « ce compte peut être rafraîchi »
-- ===========================================================================
-- Problème constaté en production le 2026-08-27 : un compte YouTube dont
-- l'access token dure une heure était affiché « Expiré » dès la 61e minute,
-- alors qu'il possédait un refresh token parfaitement valide. Le compte était
-- présenté comme mort sans l'être.
--
-- La cause : `effectiveStatus` ne raisonne que sur des DATES, et ne peut pas
-- voir `refresh_token_id` — cette colonne est volontairement hors de la liste
-- blanche accordée à `authenticated`, et elle doit le rester : c'est une
-- référence Vault.
--
-- La solution : une colonne GÉNÉRÉE qui n'expose qu'un booléen. Elle est
-- calculée par Postgres à partir de `refresh_token_id`, sans jamais en
-- divulguer la valeur. Aucun code applicatif ne peut la désynchroniser, et le
-- client apprend seulement « un moyen de rafraîchir existe » — jamais lequel.
--
-- Opération strictement additive : aucune donnée existante n'est modifiée.
-- ===========================================================================

alter table public.social_accounts
  add column if not exists can_refresh boolean
  generated always as (refresh_token_id is not null) stored;

comment on column public.social_accounts.can_refresh is
  'Dérivé de refresh_token_id : indique qu''un refresh token DISTINCT existe, sans exposer sa référence Vault.';

-- La liste blanche s'élargit d'un booléen, et d'un seul.
grant select (can_refresh) on public.social_accounts to authenticated;
