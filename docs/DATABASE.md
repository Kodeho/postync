# Database

Modèle de données de POSTYNC.

La base est hébergée sur Supabase (PostgreSQL). Les migrations vivent dans
`supabase/migrations/`, les jeux de données de démarrage dans `supabase/seed/`.

## État actuel

| Étape | Contenu                                        |
| ----- | ---------------------------------------------- |
| C3    | `profiles` + trigger de création + RLS         |
| C4    | `workspaces`, `workspace_members`, `create_workspace()`, RLS multi-tenant |

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
- `tests/integration/workspaces-multitenant.test.ts` (C4, `npm test`) : les
  mêmes scénarios contre l'API REST/RPC réelle avec de vrais JWT
  `authenticated`. Crée des comptes `postync-c4-*@example.com` et les
  supprime en fin d'exécution ; ignoré si `.env.local` est absent.

Les deux scripts SQL sont encadrés par `begin`/`rollback` et ne laissent
aucune trace.
