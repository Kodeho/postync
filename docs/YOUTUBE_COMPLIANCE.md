# Conformité YouTube — état et écarts

Ce document sépare deux procédures que l'on confond souvent, parce qu'elles ne
protègent pas la même chose et ne se franchissent pas dans le même ordre.

| | Vérification OAuth Google | Audit de conformité YouTube |
|---|---|---|
| Ce qu'elle débloque | l'accès de **n'importe quel utilisateur** à l'écran de consentement | la possibilité de publier **autrement qu'en privé** |
| Qui l'instruit | Google Trust & Safety | l'équipe YouTube API Services |
| Prérequis | domaine vérifié, écran complet, justifications, vidéo de démonstration | vérification OAuth **déjà obtenue** |

Tant que la première n'est pas passée, la seconde n'a pas d'objet.

## Écart ouvert : `privacyStatus` forcé à `private`

`youtube-publisher.ts` impose :

```ts
/** Visibilité imposée tant que le projet n'est pas audité (voir en-tête). */
const PRIVACY_STATUS = "private";
```

**Ce n'est pas une limitation subie, c'est un choix.** Un projet non audité qui
envoie une vidéo en `public` ou `unlisted` ne reçoit pas une vidéo publique :
YouTube la bascule silencieusement en privé. Le client croirait alors avoir
publié, et découvrirait le contraire par un tiers. Forcer `private` côté serveur
rend la contrainte **visible et honnête** — l'interface l'annonce d'ailleurs
avant l'envoi : « La vidéo sera publiée en Privé sur YouTube ».

### Ce que la PR d'après devra faire

Elle ne doit venir **qu'après** l'audit obtenu, et elle est plus large qu'un
simple changement de constante :

1. Remplacer la constante par un **choix explicite de l'utilisateur** —
   `public`, `unlisted` ou `private` — avec `private` par défaut.
2. Persister ce choix sur la ligne de publication : une reprise après
   interruption doit republier la **même** visibilité, jamais une valeur par
   défaut. `createContainer` reçoit déjà `privacyLevel` dans son entrée.
3. Retirer la mention « sera publiée en Privé » du formulaire, qui deviendrait
   fausse, et la remplacer par le choix.
4. Traiter `forbiddenPrivacySetting` — déjà mappé sur `privacy_rejected` dans
   `CODES` — comme un refus explicite plutôt que comme une panne : c'est la
   réponse de Google si l'audit n'est pas réellement acquis.
5. Vérifier le comportement pour une chaîne **non vérifiée** : YouTube y limite
   la visibilité indépendamment de notre audit, et l'utilisateur doit le savoir.

Tant que ces cinq points ne sont pas traités, `private` reste la seule valeur
que le produit peut promettre sans mentir.

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

Les deux pages sont publiques, accessibles sans connexion, et liées depuis le
pied de page de chaque écran. Elles ne sont pas ajoutées au pied de page
lui-même : y empiler des liens tiers le rendrait moins lisible sans rendre
l'information plus accessible.

## Blocage connu : l'acceptation n'est pas historisée

Le formulaire d'inscription annonce, **avant** le bouton d'envoi, que créer un
compte vaut acceptation des CGU et de la politique. C'est une acceptation par
l'acte, licite en droit français, et le texte est lisible avant l'engagement.

Mais **rien n'est enregistré** : aucune case à cocher, aucune colonne
`terms_accepted_at`, aucune trace de la version acceptée. En cas de litige, ou
si un examinateur demande la preuve du consentement, il n'y a rien à produire.

Ce n'est pas corrigé ici : cela demande une migration et une modification du
parcours d'inscription, hors du périmètre d'une PR de conformité documentaire.
