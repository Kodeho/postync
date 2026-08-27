# Database

Modèle de données de POSTYNC.

La base est hébergée sur Supabase (PostgreSQL). Les migrations vivent dans
`supabase/migrations/`, les jeux de données de démarrage dans `supabase/seed/`.

## État actuel

| Étape | Contenu                                        |
| ----- | ---------------------------------------------- |
| C3    | `profiles` + trigger de création + RLS         |
| C4    | `workspaces`, `workspace_members`, `create_workspace()`, RLS multi-tenant |
| C6    | `profiles.account_status`, `workspace_entitlements`, `admin_audit_logs`, RPC `admin_*`, lecture RLS pour le personnel |
| C7    | `billing_customers`, `subscriptions`, `subscription_events`, RPC `admin_list_subscriptions` / `admin_billing_stats` |
| C8.1  | `social_accounts`, `oauth_states`, wrappers Vault `social_vault_*` |

## Table `profiles`

Profil applicatif, en relation 1-1 avec `auth.users`.

| Colonne         | Type          | Contraintes                                              |
| --------------- | ------------- | -------------------------------------------------------- |
| `id`            | `uuid`        | clé primaire, `references auth.users(id) on delete cascade` |
| `display_name`  | `text`        | facultatif, 80 caractères maximum                         |
| `avatar_url`    | `text`        | facultatif                                                |
| `platform_role` | `text`        | `not null`, défaut `'user'`, valeurs contraintes          |
| `created_at`    | `timestamptz` | `not null`, défaut `now()`                                |
| `updated_at`    | `timestamptz` | `not null`, mis à jour par trigger                        |

`platform_role` accepte `user`, `support`, `admin`, `super_admin` — liste
maintenue en cohérence avec `src/types/platform-role.ts`. Toute évolution doit
modifier les deux en même temps.

La suppression d'un utilisateur dans `auth.users` supprime son profil en
cascade. Aucun mot de passe n'est stocké dans `profiles` : l'authentification
reste entièrement gérée par Supabase Auth.

## Relation avec `auth.users`

```text
auth.users
    │  insert
    ▼
trigger on_auth_user_created  (after insert, for each row)
    │
    ▼
public.handle_new_user()      (security definer, search_path = '')
    │  insert ... on conflict (id) do nothing
    ▼
public.profiles
```

`handle_new_user()` lit `raw_user_meta_data` pour pré-remplir `display_name`
(clés `display_name`, puis `full_name`, puis `name`) et `avatar_url`. Ces champs
étant optionnels, la fonction encapsule son travail dans un bloc `exception`
qui journalise un `warning` et laisse l'inscription aboutir : un profil
manquant ne doit jamais empêcher la création d'un compte.

`security definer` est nécessaire car le rôle qui écrit dans `auth.users` lors
d'une inscription n'a aucun droit sur `public.profiles`. `search_path = ''`
neutralise le détournement de schéma, d'où les noms pleinement qualifiés.

Un second trigger, `profiles_set_updated_at`, rafraîchit `updated_at` avant
chaque `update`.

## Politiques RLS

RLS est activée sur `profiles`. Deux politiques seulement, toutes deux
restreintes au rôle `authenticated` :

| Politique              | Opération | Condition                              |
| ---------------------- | --------- | -------------------------------------- |
| `profiles_select_own`  | `select`  | `using ((select auth.uid()) = id)`     |
| `profiles_update_own`  | `update`  | `using` **et** `with check` sur `auth.uid() = id` |

Aucune politique `insert` ni `delete` n'existe : RLS refusant par défaut, ces
opérations sont fermées. L'insertion passe exclusivement par le trigger, la
suppression par la cascade depuis `auth.users`.

Le `with check` de la politique `update` empêche de réattribuer une ligne
existante à un autre `id`.

## Verrouillage de `platform_role`

RLS décide quelles **lignes** sont accessibles, pas quelles **colonnes**. Le
verrouillage repose donc sur les privilèges de colonnes PostgreSQL :

```sql
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;
```

Le rôle `authenticated` n'a aucun droit d'écriture sur `platform_role`, `id`,
`created_at` ni `updated_at`. Une tentative d'escalade échoue avec
`permission denied for column platform_role`, y compris par appel direct à
l'API REST PostgREST, hors de toute logique applicative.

Seul `service_role` conserve des privilèges complets.

## Multi-tenant (C4)

```text
auth.users ──< workspace_members >── workspaces
     │              (role)               │
     └── profiles                        └── owner_id ──> auth.users
```

Un utilisateur appartient à 0..n workspaces ; un workspace a exactement un
`owner` et 0..n `admin` / `member`. **L'UUID est la référence interne** ; le
slug n'est qu'une adresse lisible pour l'URL.

### Table `workspaces`

| Colonne      | Type          | Contraintes                                                 |
| ------------ | ------------- | ----------------------------------------------------------- |
| `id`         | `uuid`        | clé primaire, `gen_random_uuid()`                            |
| `name`       | `text`        | `not null`, 1 à 80 caractères après `trim`                   |
| `slug`       | `text`        | `not null`, **unique**, `^[a-z0-9]+(-[a-z0-9]+)*$`, 60 max  |
| `owner_id`   | `uuid`        | `not null`, `references auth.users(id) on delete restrict`   |
| `created_at` | `timestamptz` | `not null`, défaut `now()`                                   |
| `updated_at` | `timestamptz` | `not null`, trigger `set_updated_at()`                       |

### Table `workspace_members`

| Colonne        | Type          | Contraintes                                               |
| -------------- | ------------- | --------------------------------------------------------- |
| `id`           | `uuid`        | clé primaire, `gen_random_uuid()`                          |
| `workspace_id` | `uuid`        | `not null`, `references workspaces(id) on delete cascade`  |
| `user_id`      | `uuid`        | `not null`, `references auth.users(id) on delete cascade`  |
| `role`         | `text`        | `not null`, `owner`, `admin` ou `member`                   |
| `created_at`   | `timestamptz` | `not null`, défaut `now()`                                 |
| `updated_at`   | `timestamptz` | `not null`, trigger `set_updated_at()`                     |

Contraintes : `unique (workspace_id, user_id)` et index unique partiel
`workspace_members_single_owner_idx` sur `(workspace_id) where role = 'owner'`
(un seul owner par workspace). `role` est aligné sur
`src/types/workspace-role.ts`.

### Cohérence `owner_id` ↔ membership owner

Deux triggers interdisent les états incohérents (`owner_id = A` mais
`A = member`) :

- `workspaces_prevent_owner_change` (`prevent_owner_change()`) : toute
  modification de `owner_id` est refusée. Le transfert de propriété n'existe
  pas en C4 ; une future RPC de transfert remplacera ce trigger.
- `workspace_members_protect_owner` (`protect_owner_membership()`) : seul
  `owner_id` peut porter le rôle `owner` ; la ligne du owner ne peut être ni
  rétrogradée, ni réattribuée, ni supprimée tant que le workspace existe. La
  cascade déclenchée par la suppression du workspace lui-même reste permise.

Ces triggers s'appliquent à tous les rôles, `service_role` compris.

### Cascades et suppression

| Évènement                              | Effet                                                    |
| -------------------------------------- | -------------------------------------------------------- |
| suppression d'un workspace             | ses `workspace_members` sont supprimées (cascade)        |
| suppression d'un utilisateur           | ses memberships sont supprimées (cascade)                 |
| suppression d'un utilisateur **owner** | **refusée** (`restrict`) tant qu'il possède un workspace |

Stratégie explicite : la disparition d'un compte ne détruit jamais un
workspace (ni les futures ressources qu'il contiendra). Il faut d'abord
transférer la propriété (à venir) ou supprimer le workspace. Le nettoyage des
données de test suit cet ordre : workspaces, puis utilisateurs.

### Fonctions

| Fonction                        | Mode               | `authenticated` | Rôle                                                                  |
| ------------------------------- | ------------------ | --------------- | --------------------------------------------------------------------- |
| `create_workspace(p_name text)` | `security definer` | **oui** (RPC)   | création atomique workspace + membership owner ; owner = `auth.uid()` |
| `is_workspace_member(uuid)`     | `security definer` | oui             | aide RLS : l'utilisateur courant est-il membre ?                      |
| `workspace_role(uuid)`          | `security definer` | oui             | aide RLS : rôle de l'utilisateur courant dans ce workspace            |
| `slugify(text)`                 | immutable          | non             | `"Mon Agence" -> "mon-agence"` (translittération explicite, sans `unaccent`) |
| `next_workspace_slug(text)`     | stable             | non             | premier slug libre : `base`, `base-2`, `base-3`, …                    |
| `prevent_owner_change()`        | trigger            | non             | voir ci-dessus                                                        |
| `protect_owner_membership()`    | trigger            | non             | voir ci-dessus                                                        |

Toutes ont `set search_path = ''` et des références pleinement qualifiées.
Les droits `execute` par défaut de Supabase sont révoqués explicitement.

`create_workspace()` :

1. refuse l'appel sans `auth.uid()` (`insufficient_privilege`) ;
2. valide le nom (1 à 80 caractères, `invalid_parameter_value` sinon) ;
3. calcule le slug de base (`slugify`, repli `workspace`) puis le premier slug
   libre ; en cas de course sur la contrainte unique, recalcule (5 essais) ;
4. insère le workspace avec `owner_id = auth.uid()` — **aucun `owner_id`
   fourni par le client n'est accepté** ;
5. insère la membership `owner` ;
6. renvoie la ligne `workspaces` créée.

Le tout dans une seule transaction : il ne peut exister ni workspace sans
owner, ni membership sans workspace.

### Slug

`Kodeho`, `Kodeho`, `Kodeho` → `kodeho`, `kodeho-2`, `kodeho-3`. La
contrainte unique en base est la source de vérité ; le navigateur n'intervient
pas dans la résolution des collisions.

### Politiques RLS (C4)

RLS activée sur `workspaces` et `workspace_members`.

| Table               | Politique                         | Opération | Condition                                                      |
| ------------------- | --------------------------------- | --------- | -------------------------------------------------------------- |
| `workspaces`        | `workspaces_select_member`        | `select`  | `is_workspace_member(id)`                                      |
| `workspaces`        | `workspaces_update_owner_admin`   | `update`  | `workspace_role(id) in ('owner','admin')` (using + with check) |
| `workspace_members` | `workspace_members_select_member` | `select`  | `is_workspace_member(workspace_id)`                            |

Aucune politique `insert` / `delete` sur `workspaces`, aucune politique
`insert` / `update` / `delete` sur `workspace_members`. Les fonctions d'aide
`security definer` évitent la récursion RLS (une politique de
`workspace_members` ne peut pas lire `workspace_members` sous RLS).

### Privilèges (C4)

```sql
revoke all on public.workspaces from anon, authenticated;
grant select on public.workspaces to authenticated;
grant update (name) on public.workspaces to authenticated;

revoke all on public.workspace_members from anon, authenticated;
grant select on public.workspace_members to authenticated;
```

`authenticated` ne peut écrire que `workspaces.name` (sous RLS owner/admin).
Un `PATCH` REST sur `workspace_members.role`, un `INSERT` d'auto-adhésion ou
une écriture de `owner_id` échouent avec `permission denied` (42501) avant
même l'évaluation des politiques. Seule `create_workspace()` (et les futures
RPC de gestion de membres) écrit dans ces tables.

## Administration Kodeho (C6)

### `profiles.account_status`

| Valeur      | Effet                                                             |
| ----------- | ----------------------------------------------------------------- |
| `active`    | accès normal (défaut)                                             |
| `suspended` | aucun accès à `/app`, `/onboarding`, ni à la création de workspace ; données conservées |
| `disabled`  | réservé (même effet que `suspended`)                              |

Modifiable uniquement par la RPC `admin_set_account_status()`. Un membre du
personnel suspendu perd aussi tout pouvoir administratif
(`current_platform_role()` renvoie `null`).

### Table `workspace_entitlements`

Droit commercial courant d'un workspace, indépendant de Stripe (une ligne par
workspace ; l'historique est dans `admin_audit_logs`).

| Colonne        | Type          | Contraintes                                              |
| -------------- | ------------- | -------------------------------------------------------- |
| `id`           | `uuid`        | clé primaire                                              |
| `workspace_id` | `uuid`        | `not null`, **unique**, `references workspaces(id) on delete cascade` |
| `access_mode`  | `text`        | `standard` \| `full_access`                               |
| `starts_at`    | `timestamptz` | `not null`, défaut `now()`                                |
| `ends_at`      | `timestamptz` | `null` = sans expiration ; sinon `> starts_at`            |
| `reason`       | `text`        | 500 caractères max                                        |
| `granted_by`   | `uuid`        | `references auth.users(id) on delete set null`            |
| `created_at` / `updated_at` | `timestamptz` | trigger `set_updated_at()`                   |

`workspace_has_full_access(uuid)` renvoie vrai si `full_access` et non
expiré : c'est ce que consommeront les futurs quotas.

### Table `admin_audit_logs`

| Colonne         | Type          | Contraintes                                        |
| --------------- | ------------- | -------------------------------------------------- |
| `id`            | `uuid`        | clé primaire                                        |
| `actor_user_id` | `uuid`        | `references auth.users(id) on delete set null`      |
| `action`        | `text`        | format `cible.evenement`                            |
| `target_type`   | `text`        | `user` \| `workspace`                              |
| `target_id`     | `text`        |                                                     |
| `metadata`      | `jsonb`       | valeurs métier uniquement (from/to, ends_at, reason) |
| `created_at`    | `timestamptz` |                                                     |

Actions journalisées : `user.suspended`, `user.reactivated`,
`user.role_changed`, `workspace.full_access_granted`,
`workspace.full_access_revoked`. Jamais de jeton, mot de passe, clé, session
ni cookie. Écriture uniquement via `admin_audit()` (interne aux RPC).

### Fonctions d'autorisation plateforme

| Fonction                        | Rôle                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `current_platform_role()`       | `platform_role` de `auth.uid()` si le compte est actif, sinon `null`          |
| `is_platform_staff()`           | `support` \| `admin` \| `super_admin`                                       |
| `assert_platform_role(text[])`  | lève `insufficient_privilege` (42501) hors liste — interne                    |

### RPC d'administration (`security definer`, `search_path = ''`)

Toutes commencent par `assert_platform_role(...)` : un appel non autorisé
échoue en **42501 quelle que soit l'application**. Écritures :

| RPC                                           | Rôles            | Règles                                                                                  | Audit |
| --------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------- | ----- |
| `admin_set_account_status(uuid, text)`        | admin, super_admin | jamais soi-même ; un admin ne touche pas un super_admin ; le dernier super_admin actif ne peut pas être suspendu | `user.suspended` / `user.reactivated` |
| `admin_set_platform_role(uuid, text)`         | admin, super_admin | admin : `user`/`support`/`admin` seulement, jamais sur un super_admin ; jamais son propre rôle, sauf démission d'un super_admin ; il reste toujours ≥ 1 super_admin actif (hors cible) | `user.role_changed` |
| `admin_grant_full_access(uuid, timestamptz, text)` | admin, super_admin | `ends_at` null ou futur ; upsert                                                   | `workspace.full_access_granted` |
| `admin_revoke_full_access(uuid, text)`        | admin, super_admin | repasse en `standard`                                                                   | `workspace.full_access_revoked` |

Lectures (`support`, `admin`, `super_admin`) : `admin_dashboard_stats()`,
`admin_list_users(search, status, role, limit, offset)`, `admin_get_user(uuid)`,
`admin_user_workspaces(uuid)`, `admin_list_workspaces(search, limit, offset)`,
`admin_get_workspace(uuid)`, `admin_workspace_members(uuid)`. Réservée à
`admin`/`super_admin` : `admin_list_audit_logs(limit, offset)`. Les e-mails
proviennent de `auth.users` via ces fonctions, jamais par lecture directe.

`create_workspace()` (C4) est redéfinie en C6 pour refuser un compte non
actif ; son corps est sinon identique.

### Politiques RLS ajoutées en C6

| Table                   | Politique                             | Condition                                        |
| ----------------------- | ------------------------------------- | ------------------------------------------------ |
| `profiles`              | `profiles_select_staff`               | `is_platform_staff()`                            |
| `workspaces`            | `workspaces_select_staff`             | `is_platform_staff()`                            |
| `workspace_members`     | `workspace_members_select_staff`      | `is_platform_staff()`                            |
| `workspace_entitlements`| `workspace_entitlements_select_member`| membre du workspace **ou** personnel             |
| `admin_audit_logs`      | `admin_audit_logs_select_admin`       | `current_platform_role() in ('admin','super_admin')` |

Aucune politique d'écriture : `authenticated` n'a que `select` sur
`workspace_entitlements` et `admin_audit_logs` ; un `PATCH` direct échoue en
42501. Les politiques C3/C4 sont inchangées.

### Amorçage du premier super_admin

`supabase/scripts/promote_super_admin.sql` : opération manuelle côté base
(SQL Editor ou `npx supabase db query --linked -f …`), à exécuter une fois
pour un compte déjà inscrit. Elle écrit une entrée `user.role_changed`
(`source: manual_bootstrap`). Aucune interface ne permet de se promouvoir.

## Facturation Stripe (C7)

Voir `docs/BILLING.md` pour les flux. Réplique locale de Stripe, écrite
uniquement côté serveur (webhook signé + Server Actions, via service_role) :
aucune politique RLS d'écriture n'existe sur ces tables.

### Table `billing_customers`

| Colonne              | Contraintes                                                    |
| -------------------- | -------------------------------------------------------------- |
| `id`                 | `uuid`, clé primaire                                            |
| `workspace_id`       | `not null`, **unique**, `references workspaces(id) on delete cascade` |
| `stripe_customer_id` | `not null`, **unique**, format `cus_…`                          |
| `created_at` / `updated_at` | trigger `set_updated_at()`                               |

Un workspace = un customer Stripe principal.

### Table `subscriptions`

`id`, `workspace_id → workspaces cascade`, `stripe_subscription_id` (unique,
`sub_…`), `stripe_customer_id`, `stripe_price_id`, `plan_key`
(`free|creator|pro|agency|unknown`), `billing_interval`
(`month|year|unknown`), `status` (`trialing|active|past_due|canceled|unpaid|
incomplete|incomplete_expired|paused`), `current_period_start/end`,
`cancel_at_period_end`, `canceled_at`, timestamps. Index unique partiel :
au plus un abonnement « vivant » (`trialing|active|past_due|unpaid|paused|
incomplete`) par workspace.

### Table `subscription_events`

`stripe_event_id` (unique, `evt_…`) = verrou d'idempotence du webhook ;
`event_type`, `processed_at`, `payload_metadata` (identifiants et statuts
uniquement, jamais le payload complet).

### RLS (C7)

| Table                 | Lecture                                             |
| --------------------- | --------------------------------------------------- |
| `billing_customers`   | membres du workspace ou personnel plateforme        |
| `subscriptions`       | membres du workspace ou personnel plateforme        |
| `subscription_events` | admin / super_admin                                 |

Aucune écriture pour `authenticated` (privilèges + absence de politique).

### RPC (C7)

`admin_list_subscriptions(limit, offset)` (support+) et
`admin_billing_stats()` (support+ ; agrégats plan/intervalle/statut — le MRR
est calculé côté application, règle dans `docs/BILLING.md`).

## Comptes sociaux (C8.1)

### Supabase Vault

Les tokens OAuth (access, refresh) et les `code_verifier` PKCE ne sont JAMAIS
stockés dans une table applicative : ils vivent dans **Supabase Vault**
(extension `supabase_vault`, chiffrement authentifié libsodium, clés hors
base). Vérifié sur le projet : le schéma `vault` n'est pas exposé par
PostgREST (PGRST106) et n'est accessible qu'à `service_role` (USAGE + SELECT).
L'application y accède par trois wrappers `security definer` du schéma
`public`, **exécutables par `service_role` uniquement** (revoke
public/anon/authenticated) : `social_vault_store(secret, name) → uuid`,
`social_vault_read(uuid) → text`, `social_vault_delete(uuid)`.

### Table `social_accounts`

| Colonne | Notes |
| --- | --- |
| `id`, `workspace_id → workspaces cascade` | connexion rattachée au WORKSPACE |
| `platform` | `instagram \| facebook \| tiktok \| youtube` |
| `provider_account_id`, `display_name`, `avatar_url` | identité du compte |
| `access_token_id` / `refresh_token_id` | **références Vault** (uuid), jamais de token en clair |
| `token_expires_at` / `refresh_expires_at` | null = non expirant |
| `scopes text[]`, `status`, `status_detail` | `active \| expired \| revoked \| error` ; detail = code court non sensible |
| `connected_by → auth.users set null`, `connected_at` | initiateur tracé |

`unique (workspace_id, platform, provider_account_id)` : multi-comptes permis,
reconnexion = mise à jour de la ligne. Trigger `social_accounts_purge_secrets`
(after delete, security definer) : les secrets Vault meurent avec la ligne,
y compris en cascade de suppression du workspace.

### Table `oauth_states`

Anti-CSRF, purement serveur : `state_hash` (SHA-256 hex du state, unique —
un dump ne permet pas de forger un callback), `workspace_id`, `user_id`,
`platform`, `code_verifier_id` (référence Vault), `redirect_slug`,
`expires_at` (TTL 10 min), `consumed_at` (usage unique, consommation
atomique). Trigger de purge du verifier à la suppression. Nettoyage
opportuniste des états expirés à chaque création.

### RLS et privilèges (C8.1)

| Table | authenticated |
| --- | --- |
| `social_accounts` | SELECT **liste blanche de colonnes** (sans `access_token_id`/`refresh_token_id` → 42501 même pour un membre) ; politique : membre du workspace ou personnel plateforme ; aucune écriture |
| `oauth_states` | aucun accès (ni grant ni politique) |

Écritures via service client uniquement (Server Actions + callback OAuth),
après contrôle applicatif session + rôle owner/admin.

## Publications sociales (C8.4b)

### Table `social_publications`

Trace des publications d'un workspace. Elle existe pour trois raisons :
faire respecter le quota `publicationsPerMonth` du plan (sans trace, ce quota
serait inapplicable), permettre la REPRISE d'une publication restée en cours
(un conteneur Instagram vit 24 h — on ne réenvoie jamais le média), et donner
un historique consultable.

| Colonne | Rôle |
| --- | --- |
| `workspace_id` | propriétaire de la publication (`on delete cascade`) |
| `social_account_id` | compte utilisé (`on delete set null` : la trace survit à une déconnexion) |
| `platform`, `provider_account_id` | conservés même si le compte disparaît |
| `media_kind` | `reel` ou `image` |
| `media_url` | URL **publique** du média source |
| `caption` | 2200 caractères maximum (contrainte alignée sur Instagram) |
| `container_id` | conteneur distant, support de la reprise |
| `provider_media_id`, `permalink` | résultat de la publication |
| `status` | `pending`, `published` ou `failed` |
| `status_detail` | code court non sensible (jamais de token, jamais de payload) |

Contrainte : une ligne `published` porte forcément `provider_media_id` **et**
`published_at`.

> `media_url` ne doit JAMAIS recevoir une URL signée ou porteuse d'un
> identifiant d'accès. Instagram exige un média publiquement accessible ;
> quand l'étape « media » apportera un stockage, y placer la clé de l'objet.

### RLS et privilèges (C8.4b)

| Table | authenticated |
| --- | --- |
| `social_publications` | SELECT (liste blanche de colonnes) ; politique : membre du workspace ou personnel plateforme ; **aucune écriture** |

Aucune colonne sensible n'existe dans cette table, mais la liste blanche
reste explicite : une colonne ajoutée plus tard n'est pas lisible tant
qu'elle n'a pas été ajoutée au `grant`.

## Appliquer la migration

```powershell
# Option 1 — SQL Editor Supabase : coller le contenu du fichier de migration.
# Option 2 — Supabase CLI :
npx supabase link --project-ref <ref-du-projet>
npx supabase db push
```

Sans mot de passe de base, `npx supabase db query --linked --project-ref <ref> -f <fichier.sql>`
exécute un fichier via l'API de management (compte CLI connecté).

## Tester les politiques

- `tests/rls-profiles.test.sql` (C3) : isolation des profils et verrouillage de
  `platform_role`. Renseigner deux UUID en tête de fichier.
- `tests/rls-workspaces.test.sql` (C4) : T1–T10 multi-tenant, escalade de
  rôle, atomicité de `create_workspace()`, slugs, rôles owner/admin/member,
  cascade et `restrict`. Auto-contenu : crée ses utilisateurs de test dans
  `auth.users` et se termine par `rollback`.
- `tests/integration/admin-foundation.test.ts` (C6, `npm test`) : A1–A13
  contre l'API réelle (user, support, admin, deux super_admin) : refus user,
  lecture support, suspension/réactivation, rôles, protection du dernier
  super_admin, Full Access, audit, perte de pouvoir d'un admin suspendu.
- `tests/integration/workspaces-multitenant.test.ts` (C4, `npm test`) : les
  mêmes scénarios contre l'API REST/RPC réelle avec de vrais JWT
  `authenticated`. Crée des comptes `postync-c4-*@example.com` et les
  supprime en fin d'exécution ; ignoré si `.env.local` est absent.

Les deux scripts SQL sont encadrés par `begin`/`rollback` et ne laissent
aucune trace.
