# Publishing Engine

Moteur de publication multi-plateformes de POSTYNC.

## État

Première brique livrée en C8.4b : **publication Instagram** (Reel et image)
depuis un compte connecté. Le planificateur, le stockage de médias et la
publication simultanée vers plusieurs comptes viendront ensuite.

## Séparation des responsabilités

- `src/server/social/providers/*` — appels distants UNIQUEMENT. Un provider ne
  connaît ni la base, ni les workspaces, ni les plans. L'interface
  `SocialPublisher` couvre quatre gestes : créer un conteneur, lire son
  statut, publier le conteneur, lire le permalien.
- `src/server/social/publish.ts` — toute l'orchestration : autorisations,
  quota, attente, persistance, reprise.
- `src/server/social/actions.ts` — Server Actions (session et rôle).

Cette séparation est ce qui rendra TikTok et YouTube ajoutables sans toucher à
l'orchestration.

## Déroulé d'une publication Instagram

1. Contrôles serveur (voir `docs/SECURITY.md`), puis lecture du token dans Vault.
2. Ligne `social_publications` créée en `pending` **avant** l'appel distant :
   une publication réellement partie ne peut pas rester sans trace.
3. `POST /<IG_ID>/media` → conteneur, dont l'identifiant est enregistré.
4. Attente bornée (45 s, paliers croissants) que le conteneur soit `FINISHED`.
5. `POST /<IG_ID>/media_publish` → identifiant du média, permalien, ligne
   passée en `published`.

## Publication asynchrone et reprise

Instagram transcode un Reel : le conteneur n'est pas publiable tout de suite,
et il reste valide 24 h. Si l'attente dépasse le budget, la ligne reste
`pending` avec son `container_id` et l'interface propose « Reprendre ».

**La reprise ne réenvoie jamais le média** : elle réinterroge le conteneur
existant puis le publie. C'est ce qui évite à la fois les doublons et un
second transfert inutile.

## Contrainte à connaître : le média doit être public

Cette API ne prend AUCUN upload direct : Instagram va chercher le fichier à
l'URL fournie, qui doit donc être publiquement accessible en https. Tant que
l'étape « media » n'apporte pas de stockage, l'URL est saisie à la main dans
l'interface.

Spécifications Reel appliquées : MP4 ou MOV, H264 ou HEVC, 3 s à 15 min,
300 Mo maximum, 23 à 60 FPS, ratio 9:16 recommandé. Images : JPEG uniquement.
Légende : 2200 caractères, 30 hashtags, 20 mentions.

## Quotas

Deux quotas indépendants s'appliquent :

- `publicationsPerMonth` du plan POSTYNC (C7), vérifié avant tout appel
  distant ; une publication en échec ne le consomme pas ;
- le quota de la plateforme (Instagram : 100 publications par 24 h glissantes).
