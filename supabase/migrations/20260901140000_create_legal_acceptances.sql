-- Historisation de l'acceptation des CGU et de la politique de confidentialité.
--
-- CE QUI MANQUAIT. Le formulaire d'inscription annonçait, avant le bouton, que
-- créer un compte valait acceptation. C'est licite, et le texte était lisible
-- avant l'engagement — mais RIEN n'était enregistré. Devant un litige ou un
-- examinateur, il n'y avait aucune preuve à produire : ni qui, ni quand, ni
-- quelle version.
--
-- CE QUI N'EST PAS STOCKÉ, et c'est aussi important que le reste : ni adresse
-- IP, ni user-agent, ni empreinte de navigateur. Ces données ne prouveraient
-- rien de plus sur le consentement, et alourdiraient inutilement le registre
-- des traitements. Quatre colonnes suffisent.

create table if not exists public.legal_acceptances (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users (id) on delete cascade,
  terms_version   text        not null,
  privacy_version text        not null,
  -- HORODATAGE SERVEUR, jamais fourni par le client. Une preuve dont la date
  -- vient de la machine qu'elle est censée engager ne prouve rien.
  accepted_at     timestamptz not null default now(),

  constraint legal_acceptances_terms_version_format
    check (terms_version ~ '^\d{4}-\d{2}-\d{2}$'),
  constraint legal_acceptances_privacy_version_format
    check (privacy_version ~ '^\d{4}-\d{2}-\d{2}$'),

  -- IDEMPOTENCE PAR LA BASE, pas par discipline applicative. Réaccepter la
  -- même paire de versions ne crée pas de seconde ligne : l'insertion est
  -- écrite `on conflict do nothing`, et c'est la contrainte qui le garantit.
  constraint legal_acceptances_unique unique (user_id, terms_version, privacy_version)
);

comment on table public.legal_acceptances is
  'Preuve d''acceptation des documents légaux, par utilisateur et par version. Aucune donnée de traçage.';
comment on column public.legal_acceptances.accepted_at is
  'Horodatage SERVEUR. Le client ne peut pas l''écrire : aucun droit d''insertion ne lui est accordé.';

-- La garde lit « cet utilisateur a-t-il accepté CE couple de versions ». C'est
-- exactement la forme de la contrainte unique, qui sert donc d'index.

-- ---------------------------------------------------------------------------
-- RLS — stricte
-- ---------------------------------------------------------------------------
alter table public.legal_acceptances enable row level security;

-- LECTURE : la sienne, et rien d'autre. Un utilisateur peut consulter ce qu'il
-- a accepté ; il ne peut pas savoir ce que les autres ont accepté, ni même
-- combien ils sont.
drop policy if exists legal_acceptances_select_own on public.legal_acceptances;
create policy legal_acceptances_select_own
  on public.legal_acceptances
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- AUCUNE POLITIQUE D'ÉCRITURE POUR `authenticated`, et c'est le point.
--
-- Une politique `insert with check (user_id = auth.uid())` aurait suffi à
-- empêcher d'accepter POUR UN AUTRE — mais pas à empêcher de forger sa propre
-- acceptation d'une version qu'on n'a jamais vue, ni de contourner la
-- validation serveur. L'écriture passe donc exclusivement par l'action
-- serveur, en `service_role`, qui décide seule des versions enregistrées.
--
-- Aucune mise à jour ni suppression n'est possible non plus : une preuve
-- d'acceptation qu'on peut réécrire n'est pas une preuve. La seule disparition
-- légitime est la cascade sur suppression du compte.

-- PRIVILÈGES DE TABLE — deuxième barrière, indépendante de RLS.
--
-- Supabase accorde par défaut TOUS les droits à `anon`, `authenticated` et
-- `service_role` sur les nouvelles tables du schéma `public`. RLS suffirait à
-- protéger les lignes — aucune politique d'écriture n'existe, donc toute
-- insertion est refusée —, mais faire reposer la garantie sur une seule
-- couche est un pari inutile : une politique ajoutée par erreur plus tard
-- deviendrait immédiatement exploitable. On retire donc le droit lui-même.
--
-- `UPDATE` n'est accordé à PERSONNE, pas même à `service_role` : une preuve
-- d'acceptation qu'on peut réécrire n'est pas une preuve. La seule
-- disparition légitime est la cascade sur suppression du compte.
-- NOTE — le `delete` accordé ici à `service_role` est RETIRÉ par la migration
-- `20260901150000`. Il n'était nécessaire à rien : la cascade sur suppression
-- du compte est exécutée par le moteur, pas par un appel applicatif. Ce
-- fichier n'est pas corrigé en place — il est déjà appliqué, et le réécrire
-- ferait diverger la migration de ce qui a réellement été exécuté.
revoke all on table public.legal_acceptances from public, anon, authenticated;
revoke all on table public.legal_acceptances from service_role;
grant select on table public.legal_acceptances to authenticated;
grant select, insert, delete on table public.legal_acceptances to service_role;
