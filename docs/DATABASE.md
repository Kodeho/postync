# Database

Modèle de données de POSTYNC.

La base est hébergée sur Supabase (PostgreSQL). Les migrations vivent dans
`supabase/migrations/`, les jeux de données de démarrage dans `supabase/seed/`.

## État actuel

| Étape | Contenu                                        |
| ----- | ---------------------------------------------- |
| C3    | `profiles` + trigger de création + RLS         |

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

## Appliquer la migration

```powershell
# Option 1 — SQL Editor Supabase : coller le contenu du fichier de migration.
# Option 2 — Supabase CLI :
npx supabase link --project-ref <ref-du-projet>
npx supabase db push
```

## Tester les politiques

`tests/rls-profiles.test.sql` vérifie côté base qu'un utilisateur A ne peut ni
lire ni modifier le profil d'un utilisateur B, et qu'il ne peut pas s'octroyer
`super_admin`. Renseigner les deux UUID en tête de fichier, puis exécuter le
script dans le SQL Editor. Il est encadré par `begin`/`rollback` et ne laisse
aucune trace.
