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

À l'issue de C3, **aucun code n'utilise `SUPABASE_SERVICE_ROLE_KEY`** : elle est
seulement déclarée dans `.env.example` en prévision des étapes suivantes.
`src/lib/supabase/env.ts` ne la lit délibérément pas, alors que ce module est
importé par du code client.

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

`/app` est protégée à deux niveaux : par le Proxy, et par un `getUser()` dans
le composant serveur de la page lui-même. Un contrôle d'accès reposant
uniquement sur le middleware/proxy est fragile — une requête qui parviendrait à
le contourner atteindrait directement le composant. La vérification faisant
autorité est celle de la page.

## Rôles

`platform_role` (`user`, `support`, `admin`, `super_admin`) servira à
l'administration Kodeho. Son écriture est fermée au rôle `authenticated` par
les privilèges de colonnes PostgreSQL, pas par du code applicatif : voir
`docs/DATABASE.md`. L'escalade `user -> super_admin` est donc impossible depuis
le client, y compris par appel direct à l'API REST.

Sa modification passe exclusivement par `service_role` ou une migration
contrôlée.

`WorkspaceRole` n'est pas encore utilisé.

## RLS

RLS est activée sur `profiles` et ne doit jamais être désactivée pour
contourner un problème. Une politique manquante se corrige en ajoutant la
politique, pas en levant RLS.

Le test `tests/rls-profiles.test.sql` valide l'isolation entre utilisateurs au
niveau de la base, indépendamment de l'interface.

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
- Isolation par workspace : à traiter avec le modèle de données correspondant.
- Limitation de débit applicative : seul le rate limit natif Supabase agit.
