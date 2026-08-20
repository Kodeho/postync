# Security

Principes de sécurité de POSTYNC.

## Variables d'environnement

| Variable                            | Portée     | Exposée au navigateur |
| ----------------------------------- | ---------- | --------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`          | publique   | oui                   |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`     | publique   | oui                   |
| `SUPABASE_SERVICE_ROLE_KEY`         | **privée** | **jamais**            |
| `NEXT_PUBLIC_SITE_URL`              | publique   | oui                   |

Les valeurs réelles vivent uniquement dans `.env.local`, ignoré par Git.
`.env.example` est commité et ne contient que des clés vides.

### Clé `service_role`

Cette clé **contourne RLS**. Trois règles absolues :

1. jamais préfixée par `NEXT_PUBLIC_` ;
2. jamais importée depuis un module atteignable par le navigateur ;
3. jamais commitée.

Depuis C7, la clé est utilisée par UN SEUL module applicatif :
`src/server/supabase/service-client.ts` (marqué `server-only` — tout import
côté client casse le build). Usage strictement limité aux écritures de
facturation : le webhook Stripe (authentifié par sa signature, sans session)
et les Server Actions de checkout/portail (après vérification session + rôle
workspace). L'administration Kodeho (C6) continue de passer par des RPC
`security definer` avec le JWT de l'administrateur, sans service_role. `src/lib/supabase/env.ts` ne la lit délibérément
pas, alors que ce module est importé par du code client.

Seuls les tests d'intégration (`tests/integration/*.test.ts`) la lisent (depuis `.env.local`, côté Node, jamais bundlé) pour créer, inspecter
et supprimer ses propres données de test. Les politiques elles-mêmes y sont
exercées avec de vrais JWT `authenticated`.

## Séparation client / serveur

| Fichier                          | Contexte    | Clé utilisée |
| -------------------------------- | ----------- | ------------ |
| `src/lib/supabase/client.ts`     | navigateur  | anon         |
| `src/lib/supabase/server.ts`     | serveur     | anon         |
| `src/lib/supabase/middleware.ts` | Proxy       | anon         |

`server.ts` importe `next/headers`. Cet import échoue à la compilation dans un
composant client, ce qui empêche structurellement le module serveur de fuiter
vers le navigateur.

Tous les clients n'utilisent que la clé anon : chaque requête reste donc
soumise aux politiques RLS de l'utilisateur connecté.

## Session et cookies

La session est portée par des cookies gérés par `@supabase/ssr`.

`src/proxy.ts` (convention Next.js 16 ; `middleware.ts` est déprécié) appelle
`updateSession()` à chaque requête non statique pour rafraîchir les jetons.

Deux points de vigilance implémentés dans `src/lib/supabase/middleware.ts` :

- **Cookies sur les redirections.** Les cookies rafraîchis sont recopiés sur
  toute réponse renvoyée, redirections comprises. Les omettre déconnecterait
  l'utilisateur à chaque redirection.
- **En-têtes anti-cache.** Depuis `@supabase/ssr` 0.12, `setAll` reçoit un
  second argument `headers` contenant les en-têtes qui interdisent la mise en
  cache. Les ignorer permettrait à un CDN de servir la session d'un
  utilisateur à un autre.

### `getUser()` et non `getSession()`

Toute décision d'autorisation utilise `supabase.auth.getUser()`, qui revalide
le jeton auprès du serveur d'authentification. `getSession()` se contente de
lire les cookies : son contenu est falsifiable et ne doit jamais servir de base
à un contrôle d'accès.

### Le Proxy n'est pas l'unique barrière

`/app`, `/app/[workspaceSlug]`, `/onboarding` et `/admin/*` sont protégées à
deux niveaux : par le Proxy, et par un `getUser()` dans le composant serveur de la
page lui-même (`requireUser()` dans `src/features/workspaces/queries.ts`). Un contrôle d'accès reposant
uniquement sur le middleware/proxy est fragile — une requête qui parviendrait à
le contourner atteindrait directement le composant. La vérification faisant
autorité est celle de la page.

## Facturation (C7)

- Le webhook `/api/stripe/webhook` vérifie la signature Stripe sur le raw
  body (`STRIPE_WEBHOOK_SECRET`) et traite les événements de façon
  idempotente (`subscription_events`). Une signature invalide → 400.
- Le checkout et le portail exigent : session valide, compte actif,
  membership réelle, rôle `owner`/`admin` du workspace. Un `member` ne peut
  pas modifier la facturation.
- Le navigateur ne transmet jamais de `workspace_id`, `price_id` ou montant :
  seulement un slug (résolu sous RLS) et un couple (plan, intervalle) validé
  puis mappé côté serveur (`src/server/stripe/config.ts`).
- `success_url` / `cancel_url` / `return_url` sont construites par le serveur
  depuis l'origine du site : pas de redirection ouverte.
- Metadata Stripe : `workspace_id` et `plan_key` uniquement. Jamais de jeton,
  secret, mot de passe ; jamais de payload Stripe complet en base.
- Un abonnement Stripe ne confère AUCUN droit d'accès multi-tenant : RLS et
  memberships (C4) restent seuls juges. Le Full Access Kodeho (C6) est
  prioritaire sur tout abonnement (`docs/BILLING.md`).

## Rôles

`platform_role` (`user`, `support`, `admin`, `super_admin`) servira à
l'administration Kodeho. Son écriture est fermée au rôle `authenticated` par
les privilèges de colonnes PostgreSQL, pas par du code applicatif : voir
`docs/DATABASE.md`. L'escalade `user -> super_admin` est donc impossible depuis
le client, y compris par appel direct à l'API REST.

Sa modification passe exclusivement par `service_role` ou une migration
contrôlée.

### `platform_role` ≠ rôle workspace

Deux systèmes de rôles coexistent et restent **indépendants** :

| Système           | Où                              | Valeurs                              | Portée                              |
| ----------------- | ------------------------------- | ------------------------------------ | ----------------------------------- |
| `platform_role`   | `profiles.platform_role`        | `user`, `support`, `admin`, `super_admin` | administration POSTYNC (Kodeho) |
| rôle workspace    | `workspace_members.role`        | `owner`, `admin`, `member`           | un workspace donné                  |

Être `owner` d'un workspace ne confère aucun droit plateforme ; être
`super_admin` POSTYNC ne confère aucun rôle dans un workspace (et n'est pas
pris en compte par les politiques RLS des workspaces). Aucune politique, aucun
code ne doit dériver l'un de l'autre. Seul `platform_role` ouvre `/admin`.

## Administration Kodeho (C6)

### Deux univers

| Espace    | Routes     | Accès décidé par                                   |
| --------- | ---------- | -------------------------------------------------- |
| client    | `/app/*`   | memberships de `workspace_members` (C4)            |
| Kodeho    | `/admin/*` | `profiles.platform_role` + `account_status = active` |

Un utilisateur standard qui demande `/admin/*` obtient un **404** : l'existence
de l'administration n'est pas révélée. Un membre du personnel suspendu perd
tout pouvoir.

### Chaîne d'autorisation obligatoire

```text
session (getUser) -> profil -> account_status = active -> platform_role
  -> permission (matrice) -> RPC admin_* (qui REFAIT le contrôle en base, puis audite)
```

Implémentée dans `src/server/admin/` : `authorization.ts`
(`requirePlatformRole`, `requireSuperAdmin`, `requireAdminAction`),
`permissions.ts` (matrice pure), `actions.ts` (Server Actions),
`queries.ts` (lectures), `audit.ts`. Les composants n'embarquent aucune
décision d'autorisation. Aucun `PATCH` client direct sur `profiles` ou
`workspace_entitlements` n'est possible (privilèges PostgreSQL).

### Matrice de permissions

| Action                           | support | admin | super_admin |
| -------------------------------- | ------- | ----- | ----------- |
| Lire utilisateurs / workspaces   | oui     | oui   | oui         |
| Suspendre / réactiver            | non     | oui   | oui         |
| Full Access (grant / revoke)     | non     | oui   | oui         |
| Voir l'audit                     | non     | oui   | oui         |
| Rôles user / support / admin     | non     | oui   | oui         |
| Attribuer / modifier super_admin | non     | non   | oui         |

Règles complémentaires imposées en base : personne ne modifie son propre
statut ; personne ne modifie son propre rôle, sauf la démission d'un
super_admin ; un admin ne touche jamais un super_admin ; **il reste toujours
au moins un super_admin actif** (ni rétrogradation ni suspension du dernier).

### Suspension

`account_status` est contrôlé côté serveur à chaque requête privée
(`requireUser()` → `/account-suspended`) et côté base (`create_workspace()`
refuse un compte non actif ; `current_platform_role()` devient `null`).
Aucune donnée n'est supprimée. C6 n'offre ni suppression définitive ni
impersonation.

### Full Access

Droit commercial par workspace (`workspace_entitlements`), indépendant de
Stripe : partenaires, démonstrations, licences offertes. Accordé/retiré par les
RPC `admin_grant_full_access` / `admin_revoke_full_access`, avec `reason`,
`granted_by`, expiration facultative, et audit systématique.

### Audit

Chaque action sensible écrit dans `admin_audit_logs` (acteur, action, cible,
metadata métier). Interdits dans les metadata : jeton, mot de passe, clé,
service_role, session, cookie. Lecture réservée à admin/super_admin.

### Premier super_admin

Opération manuelle documentée (`supabase/scripts/promote_super_admin.sql`),
jamais depuis l'interface.

## Multi-tenant (C4)

### Modèle

```text
auth.uid()  ->  workspace_members  ->  workspace demandé  ->  (futures ressources)
```

Toute décision d'accès à un workspace part de `auth.uid()` et passe par une
membership réelle en base. Les futures ressources (comptes sociaux, médias,
publications, abonnements) porteront un `workspace_id` et seront filtrées par
les mêmes fonctions d'aide RLS.

### Interdiction de faire confiance au client

Un `workspace_id` ou un slug reçu du navigateur n'est **jamais** une
autorisation :

- le slug d'URL `/app/[workspaceSlug]` est confronté côté serveur aux
  memberships de l'utilisateur (lues sous RLS) ; un slug mal formé, inconnu ou
  appartenant à un workspace dont l'utilisateur n'est pas membre produit le
  même 404 (`src/features/workspaces/resolve.ts`) ;
- la RPC `create_workspace()` impose `owner_id = auth.uid()` ;
- le Proxy ne vérifie que la session ; l'appartenance est vérifiée dans la
  page, qui est la barrière faisant autorité.

### Isolation et stratégie RLS

RLS est activée sur `workspaces` et `workspace_members` (détail dans
`docs/DATABASE.md`). Lecture d'un workspace et de ses memberships : membres
uniquement. Modification du nom : `owner` et `admin`. Tout le reste est fermé.

La défense est en profondeur : même si une politique était mal écrite, les
privilèges PostgreSQL n'accordent à `authenticated` que `select` sur les deux
tables et `update (name)` sur `workspaces`. Aucun `insert`, `update` ou
`delete` sur `workspace_members` n'est possible par l'API REST.

### Escalade de privilèges

| Tentative                                     | Résultat                                  |
| --------------------------------------------- | ----------------------------------------- |
| `member -> admin` (PATCH `role`)              | `permission denied` (42501)               |
| `member -> owner`, `admin -> owner`           | `permission denied` (42501)               |
| s'ajouter dans un workspace (INSERT)          | `permission denied` (42501)               |
| écrire `workspaces.owner_id`                  | `permission denied` (42501)               |
| second owner / rétrograder ou retirer le owner (même `service_role`) | refusé par trigger |

Le transfert de propriété n'existe pas en C4 ; il passera par une RPC
`security definer` dédiée, seule voie prévue pour modifier `owner_id`.

### Rôles workspace

| Rôle     | Lire | Renommer | Gérer les membres        | Supprimer / transférer |
| -------- | ---- | -------- | ------------------------ | ---------------------- |
| `owner`  | oui  | oui      | à venir (RPC)            | à venir (RPC)          |
| `admin`  | oui  | oui      | à venir (non-owner, RPC) | non                    |
| `member` | oui  | non      | non                      | non                    |

### Tests

`tests/rls-workspaces.test.sql` (niveau base, impersonation PostgREST) et
`tests/integration/workspaces-multitenant.test.ts` (API réelle, vrais JWT)
couvrent T1–T10, l'atomicité, les slugs, les rôles et l'escalade.

## RLS

RLS est activée sur `profiles`, `workspaces`, `workspace_members`,
`workspace_entitlements` et `admin_audit_logs` et ne doit
jamais être désactivée pour contourner un problème. Une politique manquante se
corrige en ajoutant la politique, pas en levant RLS.

Les tests `tests/rls-profiles.test.sql` et `tests/rls-workspaces.test.sql`
valident l'isolation au niveau de la base, indépendamment de l'interface.

## Traitement des erreurs

`src/features/auth/errors.ts` traduit les codes d'erreur Supabase en messages
français. Aucun message technique n'atteint l'utilisateur : les codes inconnus
retombent sur un message générique et le détail réel n'est journalisé que côté
serveur.

Les messages renvoyés par `/auth/callback` transitent par un identifiant court
(`?error=confirmation`) résolu contre une table de correspondance. Le contenu
de l'URL n'est jamais affiché tel quel.

### Compromis assumé : énumération d'adresses

Le formulaire d'inscription affiche « Cette adresse e-mail est déjà utilisée. »,
comme demandé au cahier des charges C3. Cela révèle qu'une adresse est inscrite.
Supabase masque par défaut cette information pour empêcher l'énumération de
comptes. Le message est ici volontairement explicite au profit de la clarté
utilisateur ; à réévaluer si l'énumération devient un risque identifié.

En revanche, la connexion ne distingue jamais « adresse inconnue » de « mot de
passe incorrect » : le message est identique dans les deux cas.

## Confirmation d'adresse e-mail

`/auth/callback` prend en charge les deux formats de lien émis par Supabase :
`?code=` (flux PKCE, via `exchangeCodeForSession`) et `?token_hash=&type=`
(flux OTP, via `verifyOtp`). Sans jeton valide, aucune session n'est ouverte et
l'utilisateur est renvoyé vers `/login`. La confirmation n'est jamais
contournée.

Le paramètre `?next=` est filtré : seuls les chemins internes sont acceptés
(`//hôte` est rejeté), ce qui ferme la redirection ouverte.

## Points ouverts

- Jetons OAuth des plateformes sociales : chiffrement au repos à définir.
- Gestion des membres, transfert de propriété et suppression de workspace :
  RPC `security definer` à écrire (le modèle de sécurité les attend).
- Limites de création de workspaces : à brancher sur le futur module billing
  (`CanCreateWorkspace?`) avant l'appel à `create_workspace()`.
- Limitation de débit applicative : seul le rate limit natif Supabase agit.
