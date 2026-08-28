# Architecture

Vue d'ensemble technique de POSTYNC.

POSTYNC est une application SaaS permettant d'importer une vidéo une seule fois
puis de la publier sur plusieurs réseaux sociaux (Instagram, Facebook, TikTok,
YouTube) depuis une interface centralisée.

Stack : Next.js (App Router), React, TypeScript, Tailwind CSS.

Organisation du code source (`src/`) :

- `app/` — routes App Router
- `components/` — composants partagés (`ui/`, `layout/`)
- `features/` — modules fonctionnels (auth, workspaces, accounts, billing,
  media, publishing, calendar, admin)
- `integrations/` — connecteurs des plateformes sociales (meta, tiktok, youtube)
- `server/` — logique côté serveur (auth, billing, jobs, publishing, security)
- `lib/` — utilitaires transverses
- `config/` — configuration produit
- `types/` — types partagés

À la racine de `src/` :

- `proxy.ts` — point d'entrée Proxy de Next.js 16. **La convention
  `middleware.ts` est dépréciée depuis la v16 et renommée `proxy.ts`** ; le
  fichier doit se trouver au même niveau que `app/`. Il délègue à
  `src/lib/supabase/middleware.ts` pour le rafraîchissement de session et la
  protection de `/app`.

## Routes

| Route             | Accès  | Rôle                                    |
| ----------------- | ------ | --------------------------------------- |
| `/`               | public | page d'accueil temporaire               |
| `/login`          | public | connexion                               |
| `/signup`         | public | inscription                             |
| `/auth/callback`  | public | confirmation d'adresse e-mail Supabase  |
| `/onboarding`     | privé  | création du premier workspace           |
| `/app`            | privé  | résolveur : redirige vers le workspace actif ou `/onboarding` |
| `/app/[workspaceSlug]` | privé | vue d'ensemble du workspace (shell C5) |
| `/app/[workspaceSlug]/publish` | privé | placeholder « Nouvelle publication » |
| `/app/[workspaceSlug]/calendar` | privé | placeholder calendrier |
| `/app/[workspaceSlug]/media` | privé | placeholder médiathèque |
| `/app/[workspaceSlug]/accounts` | privé | placeholder comptes sociaux (4 plateformes, non connectées) |
| `/app/[workspaceSlug]/analytics` | privé | placeholder statistiques |
| `/app/[workspaceSlug]/settings` | privé | paramètres minimaux (workspace, profil, préférences) |
| `/app/[workspaceSlug]/billing` | privé | placeholder abonnement |
| `/account-suspended` | privé | message pour un compte suspendu (déconnexion possible) |
| `/admin` | Kodeho | dashboard plateforme (données réelles + placeholders) |
| `/admin/users`, `/admin/users/[userId]` | Kodeho | liste, fiche, suspension, rôles |
| `/admin/workspaces`, `/admin/workspaces/[workspaceId]` | Kodeho | liste, fiche, membres, Full Access |
| `/admin/subscriptions` | Kodeho | placeholder (Stripe en C7) |
| `/admin/plans` | Kodeho | offres de référence (`src/config/plans.ts`) |
| `/admin/platform` | Kodeho | environnement et état des intégrations (sans secret) |
| `/admin/audit` | Kodeho (admin, super_admin) | journal `admin_audit_logs` |
| `/app/[workspaceSlug]/billing/success` | privé | retour Checkout (n'active rien) |
| `/app/[workspaceSlug]/billing/cancel` | privé | retour Checkout (abandon) |
| `/api/stripe/webhook` | Stripe (signature) | synchronisation des abonnements |
| `/api/oauth/[provider]/callback` | provider OAuth (state signé usage unique) | retour de connexion sociale |

## Modèle multi-tenant (C4)

```text
User (auth.users + profiles)
  │
  ▼
Membership (workspace_members : owner | admin | member)
  │
  ▼
Workspace (workspaces)
  │
  ▼
future resources (comptes sociaux, médias, publications, abonnements…)
```

Un utilisateur peut appartenir à plusieurs workspaces ; chaque workspace est
isolé des autres par RLS (voir `docs/SECURITY.md`, `docs/DATABASE.md`).

### Workspace actif

Stratégie retenue : **le workspace actif est porté par l'URL**,
`/app/[workspaceSlug]`. Aucune préférence persistée, aucun cookie de
sélection.

- `/app` lit les memberships de l'utilisateur (sous RLS) : aucune → redirige
  vers `/onboarding` ; sinon → redirige vers le workspace le plus ancien.
- `/app/[workspaceSlug]` confronte le slug aux memberships réelles
  (`findMembershipBySlug`) ; tout slug non résolu donne un 404.
- Le sélecteur de workspace est une simple liste de liens vers
  `/app/<slug>` ; « Créer un autre workspace » appelle la même Server Action
  que l'onboarding.

Ce choix est explicite, sans état caché, et chaque requête revalide
l'appartenance côté serveur.

### Shell applicatif (C5)

Toutes les routes `/app/[workspaceSlug]/*` partagent le layout
`src/app/app/[workspaceSlug]/layout.tsx`, qui résout le contexte du workspace
(`getWorkspaceContext`, mémoïsé par requête avec `React.cache`) et rend
`AppShell` :

```text
AppShell (Server)
├── Sidebar (Server)            desktop lg+ ; réutilisée dans le tiroir mobile
│   ├── WorkspaceSwitcher (Client)  memberships réelles + <dialog> « Nouveau workspace »
│   ├── SidebarNav ×3 (Client)      route active via usePathname (aria-current)
│   └── UserMenu (Client)           Mon profil / Paramètres / Se déconnecter
├── Header (Server)
│   ├── MobileNav (Client)          tiroir < lg, contient <Sidebar />
│   ├── HeaderTitle (Client)        titre déduit de la route active
│   └── UserMenu compact (Client)
└── <main> {page}
```

Les pages rappellent `getWorkspaceContext()` (même requête → même résultat)
et restent chacune une barrière d'autorisation. Les données métier absentes
sont présentées comme des états vides explicites (`EmptyState`, `StatCard`
avec « — ») ; aucune donnée d'identité n'est inventée.

Système de design : variables CSS dans `src/app/globals.css` (`background`,
`surface`, `border`, `foreground`, `muted`, `primary`, `danger`, `success`,
`warning`…) exposées à Tailwind v4 via `@theme`. Version claire uniquement ;
le variant `dark:` est neutralisé (`[data-theme="dark"]`, jamais posé).
Icônes : `lucide-react`. Typographie : Geist (déjà chargée via `next/font`).

## Administration Kodeho (C6)

```text
/app/*   espace client   : rôle workspace (owner | admin | member)
/admin/* espace Kodeho   : platform_role (support | admin | super_admin)
```

Les deux univers ne se croisent jamais : un `owner` de workspace reste un
`user` plateforme ; un `super_admin` n'est membre d'aucun workspace par
défaut. `src/app/admin/layout.tsx` appelle `requirePlatformRole()` (404 sinon)
et rend `AdminShell` (`src/components/admin/`) — même famille visuelle, badge
« POSTYNC ADMIN by Kodeho », navigation : Dashboard, Utilisateurs,
Workspaces, Abonnements, Plans, Plateforme, Audit ; en bas : Retour à POSTYNC,
profil admin, Déconnexion.

Couche serveur `src/server/admin/` : `authorization` · `permissions` ·
`queries` · `actions` · `audit` · `platform-status`. Les pages lisent via des
RPC `admin_*` (`security definer`) et les actions écrivent via les mêmes RPC :
la base revérifie le rôle et journalise. Plans et quotas : `src/config/plans.ts`.

### Facturation (C7)

`src/server/stripe/` (config, client, actions, webhook — tous `server-only`),
`src/server/billing/` (access = résolution Full Access → abonnement → Free,
queries sous RLS), `src/server/supabase/service-client.ts` (service_role,
webhook et actions uniquement), `src/features/billing/billing-forms.tsx`
(formulaires client). Détails : `docs/BILLING.md`.

### Comptes sociaux (C8.1)

`src/server/social/` : `pkce` (state + PKCE S256, pur), `oauth-state`
(usage unique + TTL, Vault), `vault` (wrappers service_role), `accounts`
(statuts/quotas, pur), `queries` (RLS), `actions` (connect/disconnect,
owner/admin), `callback` (traitement générique injecté de dépendances),
`providers/types` (interface `SocialProvider` + registre),
`providers/youtube` (C8.2 : flux web-server officiel Google — `client_secret`,
`access_type=offline` + `prompt=consent`, autorisation incrémentale, scope
minimal `youtube.readonly` ; `youtube.upload` sera ajouté en incrémental à
l'étape publication), `providers/tiktok` (C8.3 : Login Kit Web v2, scopes en
virgules, rotation du refresh token, scope minimal `user.info.basic` ; le
serveur d'autorisation annonce ses erreurs en **HTTP 200** avec un champ
`error`, donc la lecture ne se fie jamais au seul statut HTTP),
`providers/instagram` (C8.4a : « Instagram API with Instagram Login », scope
minimal `instagram_business_basic`, jeton longue durée auto-rafraîchi, aucune
révocation côté application — voir `docs/META_ARCHITECTURE.md`). Facebook, avec
son flux Pages distinct, fera l'objet de sa propre sous-étape. Chaque provider
est ajouté après vérification de sa documentation officielle. UI :
`/app/[workspaceSlug]/accounts` + `src/features/accounts/account-forms.tsx`.

### Planification (C10.1)

`src/server/social/schedule.ts` programme une publication : mêmes contrôles
que la publication immédiate, appliqués À LA SAISIE (compte du workspace,
compte actif, réseau capable, scopes réellement accordés, compatibilité du
média, quota du plan), puis insertion d'une ligne `scheduled` portant son
échéance. Aucune URL signée n'est forgée : elle n'aurait aucun sens des heures
à l'avance.

L'exécution repose sur `claim_due_publications()`, en base. La réclamation est
une TRANSITION D'ÉTAT atomique (`scheduled` -> `pending`) avec
`for update skip locked` : deux exécutions concurrentes ne peuvent pas réclamer
la même ligne, ce qu'un test éprouve en les lançant ensemble. Un planificateur
qui publierait deux fois serait pire que pas de planificateur — l'erreur est
publique et irrattrapable. Le statut `pending` est celui qui existait déjà pour
« en cours, reprenable » : le mécanisme de reprise de C8.4b s'applique sans
code nouveau. `attempts` borne les reprises.

### Vue d'ensemble (C12)

`src/server/social/overview.ts` construit l'écran d'accueil. Il affichait
jusqu'ici quatre tirets et « Aucune publication pour le moment » à un workspace
qui en comptait huit : un premier écran qui ment apprend à l'utilisateur à ne
pas s'y fier.

L'ordre des sections n'est pas décoratif. **Ce qui exige une action vient en
premier** — publications en échec avec leur raison, comptes dont l'autorisation
ne fonctionne plus. Programmer sert à ne PAS surveiller ; un échec de 3 h du
matin qui n'apparaît qu'au fond du calendrier ne serait découvert que des jours
plus tard. Un compte inutilisable passe avant un échec constaté : il bloque
tout ce qui vient, alors que l'échec est derrière.

`buildOverview` est pure et testée : le placement au jour et au mois se fait en
heure LOCALE, la même exigence que le calendrier. La requête borne les
publications à la plus ancienne des deux dates utiles — début du mois pour le
compteur mensuel, fenêtre de 14 jours pour les échecs — car ne garder que la
seconde amputerait le compteur mensuel dès le 15.

### Publication multi-réseaux (C11)

`src/server/social/broadcast.ts` tient enfin la promesse du produit : un média,
plusieurs réseaux, une seule demande. Il n'écrit rien de neuf — il ORCHESTRE
`publishToSocialAccount` et `schedulePublication`, validés en C8 et C10.

Trois principes, dictés par ce qui peut mal tourner :

* **Le quota est vérifié pour le LOT entier, avant tout envoi.** Un utilisateur
  à qui il reste deux publications et qui en demande trois n'en verrait
  autrement partir que deux, avant de récolter un échec — deux contenus
  publiés qu'il n'avait pas choisi de dissocier.
* **Un échec partiel reste un échec partiel.** Le résultat est rendu réseau par
  réseau, jamais agrégé en un verdict unique : prétendre à la réussite ferait
  croire que le contenu est en ligne partout.
* **Chaque réseau est indépendant.** Un refus d'Instagram n'empêche pas
  Facebook de partir ; chaque cible a ses propres contrôles.

Les envois sont SÉQUENTIELS : en parallèle, les contrôles de quota internes
liraient tous le même compteur d'avant l'envoi et laisseraient passer plus de
publications que le plan n'en autorise.

Le budget d'attente par réseau est court (12 s) : ce qui n'aboutit pas reste
`pending` avec son conteneur, et le planificateur de C10.2 le reprend — le
média n'est jamais renvoyé.

La compatibilité est calculée CÔTÉ SERVEUR et le navigateur ne reçoit qu'un
verdict et son explication. Les règles diffèrent nettement d'un réseau à
l'autre ; les dupliquer côté client garantirait qu'elles divergent.

### Calendrier et saisie d'une échéance (C10.3)

Le formulaire de publication propose « Maintenant » ou « Programmer ». Le
champ `datetime-local` ne porte AUCUN fuseau : le navigateur convertit donc
l'heure saisie en instant UTC avant l'envoi, et le serveur ne devine jamais un
fuseau. Les bornes du sélecteur sont calculées dans le gestionnaire
d'événement, pas au rendu — lire l'heure courante pendant le rendu produirait
une divergence d'hydratation.

`src/server/social/calendar.ts` construit la grille hors de tout composant :
c'est de l'arithmétique de dates, la partie qui se trompe en silence. Elle est
pure et testée, notamment sur le point qui compte — une publication programmée
à 00h30 heure locale porte un instant UTC situé la VEILLE, et la ranger
d'après l'UTC l'afficherait le mauvais jour, parfois le mauvais mois. Les
bornes de la requête sont élargies d'un jour de chaque côté pour la même
raison.

Le mois vient de l'URL (`?mois=AAAA-MM`), ce qui rend la vue partageable ; un
paramètre invalide retombe sur le mois courant. Une publication encore
`scheduled` peut être annulée ; dès qu'elle est réclamée, le bouton disparaît
et le serveur refuserait de toute façon — mieux vaut ne pas proposer une
action qui échouera.

### Exécution du planificateur (C10.2)

Le plan Vercel du projet est Hobby, où les crons sont limités à UNE exécution
par jour : inutilisable ici. C'est donc la base qui se réveille elle-même —
`pg_cron` chaque minute, `pg_net` pour appeler `POST /api/cron/publish`.

Le secret partagé vit dans Vault et les DEUX extrémités l'y lisent : le job via
`vault.decrypted_secrets`, l'application via `scheduler_secret()` (service_role
uniquement). Il est généré en base par `gen_random_bytes` : sa valeur ne
transite par aucun fichier ni aucune variable d'environnement à déployer. La
comparaison côté route est à temps constant.

`src/server/social/scheduler.ts` fait deux choses à chaque réveil : publier les
échéances dues, et REPRENDRE les publications restées en cours. La seconde est
celle qu'on oublie — sans elle, une publication dont le conteneur n'est pas
prêt attendrait qu'un humain clique. La reprise couvre les deux cas : conteneur
présent (on l'interroge, le média n'est jamais renvoyé) et conteneur ABSENT
(l'exécution est morte avant sa création : rien n'est parti, la ligne repart du
début). Son exclusion repose sur `updated_at`, que le trigger réécrit à chaque
écriture — le code applicatif ne peut pas la falsifier.

`publishToSocialAccount` accepte `existingPublicationId` : la publication est
menée à terme DANS la ligne déjà réclamée, jamais dans une seconde. L'adoption
n'accepte qu'une ligne encore `pending`, ce qui interdit de publier une ligne
annulée ou déjà partie. Le quota n'est pas recompté à l'exécution : il l'a été
à la programmation.

### Publication (C8.4b)

`src/server/social/publish.ts` orchestre la publication : contrôles
d'autorisation, quota du plan, lecture Vault, attente bornée du conteneur
distant, persistance dans `social_publications` et reprise. Les providers
n'exposent que des appels distants via l'interface `SocialPublisher`
(`createContainer`, `containerStatus`, `publishContainer`, `fetchPermalink`) :
c'est ce découpage qui permettra d'ajouter TikTok et YouTube sans toucher à
l'orchestration. UI : `src/features/accounts/publish-form.tsx`.
Détail du fonctionnement dans `docs/PUBLISHING_ENGINE.md`.

### Actifs multiples (C8.4c, Facebook)

Facebook est le premier réseau où UNE autorisation donne accès à PLUSIEURS
comptes publiables. Le contrat de provider distingue désormais deux familles :
à identité unique (`fetchIdentity` — YouTube, TikTok, Instagram) ou à actifs
multiples (`assets` — Facebook). Le callback générique aiguille sur cette
seule base.

`connection-draft.ts` porte la connexion entre le callback et le choix de
l'utilisateur ; `assets.ts` liste les actifs sans jamais laisser sortir un
jeton, puis crée une ligne `social_accounts` par Page retenue. UI :
`/app/[workspaceSlug]/accounts/select` +
`src/features/accounts/asset-selection-form.tsx`.

### Code

- `src/features/workspaces/actions.ts` — Server Action `createWorkspaceAction`
  (RPC `create_workspace`).
- `src/features/workspaces/queries.ts` — lectures serveur (`requireUser`,
  `listMemberships`).
- `src/features/workspaces/resolve.ts` — logique pure de résolution.
- `src/features/workspaces/validation.ts` — nom et format de slug.
- `src/features/workspaces/navigation.ts` — configuration des routes du
  shell, liens et route active (logique pure).
- `src/features/workspaces/context.ts` — contexte workspace par requête.
- `src/components/shell/*` — AppShell, Sidebar, Header, WorkspaceSwitcher,
  UserMenu, MobileNav, SidebarNav.
- `src/components/ui/*` — Button, Avatar, Panel, PageHeader, EmptyState,
  StatCard, TextField, FormAlert, SubmitButton.
- `src/types/workspace.ts`, `src/types/workspace-role.ts` — types.
- `src/server/admin/*` — couche d'administration (voir ci-dessus).
- `src/components/admin/*` — AdminShell, navigation, badges, tableaux,
  formulaires d'action.
- `src/config/plans.ts` — offres et quotas de référence.

Ce document sera complété au fur et à mesure des étapes suivantes.
