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

## Comptes sociaux (C8)

- **Tokens** : jamais en clair en table, jamais renvoyés au navigateur, jamais
  journalisés, jamais dans une URL POSTYNC, jamais dans `admin_audit_logs`,
  inaccessibles via RLS (colonnes hors liste blanche) et inaccessibles à
  `authenticated`/`anon` (wrappers Vault réservés à `service_role`). Ils ne
  transitent qu'en mémoire serveur entre l'API du provider et Vault.
- **Flux OAuth** : `state` 256 bits (stocké haché SHA-256), TTL 10 min,
  usage unique (consommation atomique — le replay du callback échoue) ; PKCE
  S256 quand le provider le supporte (verifier dans Vault, détruit à la
  consommation) ; `redirect_uri` construits par le serveur.
- **Callback** (`/api/oauth/[provider]/callback`) vérifie, dans l'ordre :
  state valide/non expiré/non consommé → plateforme cohérente → session
  présente ET égale à l'utilisateur INITIATEUR → rôle owner/admin ENCORE
  détenu sur le workspace du state → quota du plan pour un compte nouveau.
  Un utilisateur du workspace A ne peut pas connecter un compte au
  workspace B ; un state volé est inutilisable par un tiers et se consomme.
- **Rôles** : connecter / reconnecter / déconnecter = owner + admin ;
  member = lecture seule. Déconnexion : révocation best effort côté
  plateforme, puis suppression (purge Vault par trigger).
- **Révocation distante, cas par cas** : YouTube et TikTok exposent un endpoint
  officiel de révocation, appelé à la déconnexion. Instagram (« Instagram API
  with Instagram Login ») n'en documente AUCUN : le provider n'implémente donc
  pas `revoke` — plutôt que d'appeler une URL non documentée — et la
  déconnexion affiche `revokeNotice`, qui indique à l'utilisateur comment
  retirer l'autorisation depuis Instagram. POSTYNC ne prétend jamais avoir
  révoqué un accès qu'il n'a pas révoqué.
- **Durée de vie des jetons** : aucune hypothèse de jeton « non expirant ».
  Instagram délivre un jeton court (1 h) systématiquement converti en jeton
  longue durée (~60 j) qui se rafraîchit lui-même — sans refresh token
  distinct : `refresh_token_id` reste nul et `refreshUsesAccessToken` indique
  que le rafraîchissement consomme l'access token courant. TikTok délivre un
  access token de 24 h et un refresh token de 365 jours — mesuré en conditions
  réelles le 2026-08-27, conforme à sa documentation. Le refresh renvoyé
  « peut » différer de celui envoyé : POSTYNC le remplace SYSTÉMATIQUEMENT,
  qu'il ait changé ou non, et ne détruit l'ancien secret qu'après écriture.
- **Ce qu'une révocation TikTok emporte réellement** : vérifié en conditions
  réelles — après appel de `/v2/oauth/revoke/`, l'access token est refusé
  (`access_token_invalid`) ET le refresh token aussi (`invalid_grant`). Ce
  dernier code est celui qui fait basculer le compte en `revoked` plutôt qu'en
  erreur passagère : l'interface affiche « Accès révoqué » et propose une
  reconnexion. Un échec de révocation distante reste non bloquant pour la
  déconnexion locale, mais il est désormais journalisé — une autorisation
  restée vivante côté plateforme ne doit pas passer inaperçue.
- Le quota `socialAccounts` du plan (C7, Full Access compris) est appliqué à
  la connexion, côté serveur.
- **Le planificateur est le seul accès qui ignore le cloisonnement** (C10.1).
  `claim_due_publications()` balaie la table entière : elle n'agit pour aucun
  workspace en particulier. Elle est donc `security definer`, son `EXECUTE` est
  RÉVOQUÉ à `anon` et `authenticated`, et accordé au seul `service_role` — elle
  n'est atteignable depuis aucune session. Le quota `publicationsPerMonth`
  compte les publications `scheduled` : sans cela, tout programmer suffirait à
  publier sans limite.
- **La route du planificateur déclenche des publications : elle ne peut pas
  être ouverte** (C10.2). Le secret partagé est GÉNÉRÉ EN BASE et vit dans
  Vault ; les deux extrémités l'y lisent, aucune variable d'environnement n'est
  à déployer et sa valeur n'a jamais transité par un fichier. La comparaison
  est à temps constant — un `===` s'arrête au premier octet différent et
  laisserait fuir, mesure après mesure, la longueur du préfixe correct. Sans
  secret configuré, la route reste FERMÉE (503) : l'ouvrir « le temps de
  configurer » exposerait un déclencheur de publication à tout Internet.
- `scheduler_secret()` et `claim_stale_publications()` sont, comme
  `claim_due_publications()`, `security definer` avec `EXECUTE` révoqué à
  `anon` et `authenticated`.

## Sélection d'actifs (C8.4c, Pages Facebook)

- **Le jeton d'une Page ne quitte jamais le serveur.** L'écran de sélection ne
  reçoit qu'un identifiant, un nom, un avatar et deux booléens. Un test
  vérifie qu'aucun jeton ne figure dans ce que la couche renvoie.
- **Le jeton utilisateur ne survit pas à la sélection** : il vit dans Vault le
  temps d'énumérer les Pages, porté par un brouillon à TTL court, et meurt
  avec lui — y compris si l'utilisateur abandonne.
- **Triple filtre sur le brouillon** : id + workspace + utilisateur. Un
  identifiant de brouillon volé ne suffit pas.
- **Aucun actif n'est connecté sans figurer dans le brouillon** : les
  identifiants venus du navigateur sont recoupés avec la liste réelle.
- **Une Page sans droit de publication est refusée** plutôt que connectée :
  pas de fausse promesse.
- **Révocation** : `DELETE /<user-id>/permissions` couperait TOUTES les Pages
  d'un coup. Déconnecter une Page ne doit pas en couper d'autres, donc la
  révocation distante n'est pas câblée ; une notice explique à l'utilisateur
  comment retirer l'accès lui-même.

## Publication (C8.4b)

- **Ordre des contrôles**, tous obligatoires et tous côté serveur : URL de
  média https publique (les URL portant des identifiants sont refusées, rien
  n'est transmis à un tiers) → le compte appartient BIEN au workspace demandé
  (filtre sur les deux colonnes : un identifiant volé ne suffit pas) → compte
  actif → scope de publication RÉELLEMENT accordé → quota
  `publicationsPerMonth` du plan. Le token n'est lu dans Vault **qu'après**
  tous ces contrôles : un appel refusé n'y touche jamais.
- **Rôles** : publier et reprendre = owner + admin, comme connecter.
- **Journalisation** : uniquement des codes courts (`http_400`,
  `container_failed`…). Jamais de token, jamais de réponse brute de la
  plateforme — les messages Meta peuvent contenir des identifiants de compte.
- **Aucun secret dans `social_publications`** ; la table n'accepte aucune
  écriture depuis `authenticated`.
- **Pas de double publication** : si la plateforme signale un conteneur déjà
  publié, POSTYNC ne republie pas. Il enregistre la publication en indiquant
  dans `status_detail` que la référence conservée est celle du conteneur et
  non celle du média — plutôt que de présenter un identifiant pour un autre.
- Le quota de la PLATEFORME (Instagram : 100 publications / 24 h) est distinct
  du quota du plan POSTYNC ; les deux existent.

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
