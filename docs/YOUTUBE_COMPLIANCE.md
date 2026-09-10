# Conformité YouTube — état et écarts

Ce document sépare deux procédures que l'on confond souvent, parce qu'elles ne
protègent pas la même chose et ne se franchissent pas dans le même ordre.

| | Vérification OAuth Google | Audit de conformité YouTube |
|---|---|---|
| Ce qu'elle débloque | l'accès de **n'importe quel utilisateur** à l'écran de consentement | la possibilité de publier **autrement qu'en privé** |
| Qui l'instruit | Google Trust & Safety | l'équipe YouTube API Services |
| Prérequis | domaine vérifié, écran complet, justifications, vidéo de démonstration | vérification OAuth **déjà obtenue** |

Tant que la première n'est pas passée, la seconde n'a pas d'objet.

## Visibilité : les trois choix sont offerts — écart RÉSOLU (PR #8)

Ce chapitre décrivait un « écart ouvert » : `privacyStatus` forcé à `private`
par une constante de `youtube-publisher.ts`. **Ce n'est plus vrai depuis la
PR #8** (`youtube-upload-metadata`), et le raisonnement qui le justifiait était
lui-même faux.

L'argument avancé était que « YouTube bascule silencieusement en privé une
vidéo envoyée en `public` par un projet non audité ». **Mesure du 2026-09-02,
projet `71307782821`, non audité** : un envoi demandant `public` a produit une
vidéo RÉELLEMENT publique (`F8tUy20bY9s`), accessible sans session — oEmbed
HTTP 200 —, là où deux vidéos envoyées en `private` répondaient 403. La
documentation dit « restricted to », pas « rejected », et la restriction
annoncée ne s'appliquait pas à ce projet.

Ce garde-fou supposé n'existait donc pas. Le documenter comme acquis était le
plus coûteux des deux mensonges : il donnait l'illusion d'un filet.

### Ce qui est en place aujourd'hui

| Exigence (Required Minimum Functionality) | Où |
|---|---|
| « Users must be able to choose whether the uploaded video will be public, private, or unlisted » | `YOUTUBE_PRIVACY_STATUSES` dans `src/lib/youtube-metadata.ts`, rendu par `broadcast-form.tsx` |
| La visibilité choisie est transmise TELLE QUELLE | `status.privacyStatus` dans `youtube-publisher.ts` — aucune réécriture |
| Le choix survit à une reprise après interruption | colonne `privacy_status`, relue par `readStoredYouTubeMetadata` |
| Déclaration made-for-kids, jamais de défaut applicatif | `parseYouTubeMetadata` refuse `null` (COPPA) |
| Certification Community Guidelines horodatée | `guidelines_acknowledged_at` |

`private` reste présélectionné dans le formulaire : c'est une commodité, pas une
contrainte — l'imposer serait l'infraction.


## Divulgations obligatoires — état

Exigées par les [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service)
et les [Developer Policies](https://developers.google.com/youtube/terms/developer-policies).

| Exigence | Emplacement | État |
|---|---|---|
| Lien vers les Conditions d'utilisation de YouTube | CGU, §3 | ✅ |
| Acceptation d'être lié par ces conditions | CGU, §3 | ✅ |
| Mention des YouTube API Services | Confidentialité, §5 | ✅ |
| Lien vers la politique de confidentialité de Google | Confidentialité, §5 | ✅ |
| Lien vers les paramètres de sécurité Google (révocation) | Confidentialité, §5 | ✅ |
| Données consultées et conservées | Confidentialité, §5 | ✅ |
| Procédure de retrait et délais réels | Confidentialité, §5 et §7 | ✅ |
| Suppression des données autorisées à la révocation | `disconnect_social_account` | ✅ |

## Ce que la déconnexion efface, et ce qu'elle garde

La première rédaction de cette page annonçait que l'historique **conservait**
l'identifiant de chaîne et le lien des vidéos. C'était exact au regard du code
d'alors — et incompatible avec l'exigence de suppression des données
autorisées. Les deux ont été corrigés.

| Champ | Nature | À la déconnexion |
|---|---|---|
| `social_accounts` (ligne entière) | plateforme — identifiant de chaîne, nom, avatar, scopes | **supprimée** |
| jetons (coffre) | plateforme | **détruits** par trigger |
| `provider_account_id` | plateforme — identifiant de chaîne | **null** |
| `provider_media_id` | plateforme — identifiant de vidéo | **null** |
| `permalink` | dérivé — construit sur l'identifiant de vidéo | **null** |
| `container_id` | plateforme — URI de session résumable | **null** |
| `purged_at` | interne | horodaté |
| `caption` | fournie par l'utilisateur | conservée |
| `media_url` | locale — notre stockage | conservée |
| `platform`, `media_kind`, `status`, dates | interne | conservées |

`platform` reste : savoir qu'une publication est partie « vers YouTube » est
notre propre fait d'exploitation, pas une donnée reçue de YouTube.

**La purge s'applique à toutes les plateformes**, pas au seul YouTube. Meta et
TikTok posent des exigences équivalentes, et une asymétrie serait indéfendable :
on n'explique pas pourquoi un identifiant de vidéo TikTok survivrait là où celui
de YouTube disparaît.

**Elle est atomique.** Les trois opérations — arrêter ce qui est en cours,
purger, supprimer le compte — tiennent dans `disconnect_social_account`, donc
dans une seule transaction. Enchaînées côté application, une panne entre deux
laisserait un compte supprimé avec des identifiants de vidéos encore en base :
l'état qu'aucune politique ne permet d'expliquer.

**Elle ne dépend pas de la révocation distante.** Celle-ci est tentée d'abord et
tracée si elle échoue, mais la purge suit dans tous les cas. C'est précisément
quand l'autorisation survit chez la plateforme qu'il faut être certain de n'avoir
rien gardé. La politique de confidentialité le dit dans ces termes : nous
« demandons immédiatement à Google de révoquer » — nous ne prétendons pas que
Google le fasse à coup sûr, ce que nous ne pouvons pas garantir.

## Droits de `disconnect_social_account`

Relevés dans la base, pas déduits du fichier :

| Propriété | Valeur |
|---|---|
| Sécurité | `SECURITY DEFINER` |
| Propriétaire | `postgres` |
| `search_path` | `""` — vide ; le corps qualifie tout en `public.<table>` |
| Privilèges | `postgres=X/postgres`, `service_role=X/postgres` |
| `public`, `anon`, `authenticated` | **aucun droit** |

Deux barrières, et elles sont indépendantes :

1. **Applicative** — `disconnectAction` vérifie l'appartenance du compte au
   workspace autorisé avant d'agir.
2. **Base** — la fonction refuse un compte qui n'appartient pas au workspace
   passé, et refuse des arguments nuls. Elle LÈVE au lieu de ne rien faire :
   une déconnexion qui ne déconnecte rien est une anomalie, pas un cas nominal.

Un client `authenticated`, fût-il propriétaire du workspace, ne peut pas appeler
la fonction : la seule voie est l'action serveur.

## Les écrans après une purge

`listRecentPublications`, `listPublicationsForMonth` et `listOverviewPublications`
lisent tous `social_publications`. Tous les usages de `permalink` dans les vues
sont déjà gardés par un ternaire, donc un lien absent ne rend rien de cassé —
la ligne s'affiche simplement sans lien.

Une publication publiée puis purgée reste `published` : on n'efface pas le fait
qu'elle est partie, seulement ce qui vient de la plateforme. L'utilisateur voit
la date, le réseau, sa légende et l'état — sans lien cliquable.

Les deux pages sont publiques, accessibles sans connexion, et liées depuis le
pied de page de chaque écran. Elles ne sont pas ajoutées au pied de page
lui-même : y empiler des liens tiers le rendrait moins lisible sans rendre
l'information plus accessible.

## Acceptation des CGU : historisée — blocage RÉSOLU (PR #7)

Ce chapitre annonçait que « rien n'est enregistré : aucune case à cocher, aucune
colonne `terms_accepted_at`, aucune trace de la version acceptée ». **C'est faux
depuis la PR #7** (`feat/legal-acceptance`).

Ce qui existe aujourd'hui :

* table `legal_acceptances` — migration
  `supabase/migrations/20260901140000_create_legal_acceptances.sql`, avec
  `20260901150000_revoke_delete_on_legal_acceptances.sql` qui interdit la
  suppression : une acceptation ne s'efface pas ;
* `src/server/legal/acceptance.ts` — enregistrement du couple de versions
  réellement accepté ;
* `src/config/legal.ts` — `TERMS_VERSION` et `PRIVACY_VERSION` (`2026-09-01`),
  source unique. **Changer l'une redemande l'acceptation à tout le monde** : une
  acceptation ne vaut que pour la version acceptée, et la garde compare le
  couple enregistré au couple courant ;
* `src/app/legal/accept/page.tsx` — le parcours qui la recueille.

En cas de litige ou de demande d'un examinateur, la preuve est produisible :
qui, quand, et quelles versions.

