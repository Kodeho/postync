# C8.4 — Meta (Instagram + Facebook) : vérification d'architecture

**Statut : DÉCISION PRISE le 2026-08-26 — Option A (Instagram API with
Instagram Login) validée. Implémentée en C8.4a (connexion uniquement, aucune
publication). Facebook fera l'objet d'une sous-étape distincte.**

Ce document répond à la question posée avant toute implémentation : POSTYNC
doit-il intégrer Meta via **Facebook Login for Business + Pages** ou via
**Instagram API with Instagram Login** ? Toutes les affirmations ci-dessous sont
vérifiées sur la documentation officielle `developers.facebook.com`
(consultée le 2026-08-26) ; les sources sont listées en fin de document.

---

## 1. Les deux configurations officielles

Meta propose aujourd'hui **deux configurations distinctes** pour publier sur
Instagram. Ce ne sont pas deux façons d'appeler la même API : les hôtes OAuth,
les scopes, les jetons et le périmètre fonctionnel diffèrent.

| | **A — Instagram API with Instagram Login** | **B — Instagram API with Facebook Login for Business** |
|---|---|---|
| Comptes supportés | Instagram Business et Creator | Instagram Business et Creator |
| **Page Facebook requise ?** | **Non** | **Oui** — le compte IG doit être lié à une Page |
| Hôte d'autorisation | `www.instagram.com/oauth/authorize` | dialogue Meta avec `config_id` |
| Échange du code | `api.instagram.com/oauth/access_token` | `graph.facebook.com/<v>/oauth/access_token` |
| Jeton | IG User token longue durée **60 jours**, rafraîchissable | User token longue durée 60 j → **Page token sans expiration** |
| Scopes publication | `instagram_business_basic`, `instagram_business_content_publish` | `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` |
| Publication Instagram | IMAGE, VIDEO, REELS, STORIES, CAROUSEL | IMAGE, VIDEO, REELS, STORIES, CAROUSEL |
| **Publication sur Page Facebook** | **Impossible** | **Possible** (scopes Pages additionnels) |
| Limites annoncées | « cannot access ads or tagging » | recherche hashtag et métadonnées d'autres comptes en plus |

Point capital vérifié : **les deux configurations publient exactement les mêmes
types de médias sur Instagram**, Reels et Stories compris. Le choix ne se joue
donc pas sur la capacité de publication Instagram, mais sur (a) l'exigence d'une
Page Facebook et (b) la couverture ou non de Facebook.

---

## 2. Ce que chaque option coûte à l'utilisateur POSTYNC

### Option A — Instagram Login (Instagram seul)

Le créateur connecte son compte Instagram professionnel directement, sur
`instagram.com`. Il n'a **besoin d'aucune Page Facebook ni d'aucun compte
Facebook**. C'est le parcours le plus court possible pour un créateur solo.

Contrepartie : POSTYNC ne peut rien publier sur Facebook via cette connexion.
Couvrir Facebook exigerait une **seconde intégration séparée** (Facebook Login
for Business + Pages), donc deux connexions distinctes dans `/accounts`.

### Option B — Facebook Login for Business (Instagram + Pages)

Une seule autorisation peut délivrer à la fois la publication Instagram **et**
la publication sur les Pages Facebook (`pages_show_list`,
`pages_read_engagement`, `pages_manage_posts`). Le jeton de Page dérivé d'un
user token longue durée **n'expire pas**, ce qui simplifie beaucoup un
planificateur de publications.

Contrepartie : l'utilisateur **doit** posséder une Page Facebook liée à son
compte Instagram, et passer par un dialogue Meta plus long (sélection du
Business, de la Page, du compte Instagram). Un créateur qui n'a qu'Instagram est
purement et simplement bloqué.

---

## 3. Contrainte commune, non négociable : App Review

Quelle que soit l'option retenue, elle se heurte au même mur :

- Le **Standard Access** ne permet de demander des permissions qu'aux personnes
  **ayant un rôle dans l'application** (admin, développeur, testeur).
- Pour servir des utilisateurs réels sans rôle, il faut l'**Advanced Access**,
  qui exige la **vérification d'entreprise (Business Verification)** depuis le
  1er février 2023, **plus une App Review** par permission de publication.

Conséquence concrète pour POSTYNC : le développement et la validation E2E de
C8.4 sont possibles dès maintenant avec des comptes de test ayant un rôle dans
l'app Meta, **mais l'ouverture aux clients réels dépend d'une démarche
administrative** (vérification d'entreprise Kodeho + soumission App Review avec
captures vidéo du parcours). C'est le même schéma que TikTok.

---

## 4. Mécanique de publication

Instagram, publication en **deux temps** (identique dans les deux options) :

1. `POST /<IG_ID>/media` → crée un conteneur, renvoie un `container_id`.
   Le média doit être **hébergé sur une URL publiquement accessible** au moment
   de l'appel ; il n'y a pas d'upload direct de fichier.
2. `POST /<IG_ID>/media_publish` avec le `container_id` → publie.
   Statut intermédiaire lisible via `GET /<CONTAINER_ID>?fields=status_code`.

Quota : **100 publications API par 24 h glissantes** par compte, lisible via
`GET /<IG_ID>/content_publishing_limit`. Un carrousel compte pour 1 (10 éléments
maximum). JPEG uniquement pour les images.

Facebook, **Reel sur une Page**, en **trois temps** :
`POST /<PAGE_ID>/video_reels` (`upload_phase=start`) →
`POST rupload.facebook.com/video-upload/<VIDEO_ID>` →
`POST /<PAGE_ID>/video_reels` (`upload_phase=finish`).
Quota : **30 publications API / 24 h**. Reel : 3 à 90 s, ratio 9:16,
résolution minimale 540 × 960. Les URLs `fbcdn` sont rejetées.

Facebook, vidéo classique sur une Page : `POST /<PAGE_ID>/videos` via la
Resumable Upload API.

> Impact à retenir pour l'étape « media » : Instagram impose une **URL publique**
> pour le média. Le stockage devra donc exposer des URLs signées lisibles
> publiquement le temps de la publication. Facebook accepte en plus l'upload
> binaire direct.

---

## 5. Recommandation

**Recommandation : Option A (Instagram Login) pour C8.4, et traiter Facebook
comme une intégration distincte ultérieure.**

Raisons :

1. **Cohérence avec l'architecture existante.** `social_accounts` modélise déjà
   « un compte social = une ligne = un provider ». YouTube et TikTok suivent ce
   modèle. Instagram via Instagram Login s'y insère sans modification ;
   l'option B introduit une notion de connexion Meta multi-actifs
   (1 autorisation → N Pages + N comptes Instagram) qui casse le modèle actuel
   et impose une refonte de la table et de l'UI `/accounts`.
2. **Taux de conversion.** Le cœur de cible de POSTYNC (créateurs) possède
   Instagram et TikTok ; beaucoup n'ont ni Page Facebook ni compte Facebook.
   L'option B les bloque à la porte.
3. **Aucune perte fonctionnelle sur Instagram.** Vérifié : Reels, Stories,
   carrousels, images et vidéos sont publiables dans les deux configurations.
4. **Découplage du risque App Review.** Une App Review Instagram seule est plus
   simple à justifier qu'une demande cumulant permissions Instagram et Pages, et
   un refus sur le volet Pages ne bloquerait pas Instagram.

Le prix à payer est assumé et limité : quand Facebook sera au programme, il
faudra une seconde intégration, et un utilisateur voulant Instagram **et**
Facebook fera deux connexions.

---

## 6. Décision et mise en œuvre

**Option A retenue** : Instagram API with Instagram Login. Facebook sera
intégré séparément, avec son propre flux Meta/Pages.

Implémenté en C8.4a — `src/server/social/providers/instagram.ts` :

| Élément | Valeur retenue, vérifiée sur la doc officielle |
|---|---|
| Autorisation | `https://www.instagram.com/oauth/authorize` |
| Échange du code | `POST https://api.instagram.com/oauth/access_token` |
| Jeton longue durée | `GET graph.instagram.com/access_token` (`ig_exchange_token`) |
| Rafraîchissement | `GET graph.instagram.com/refresh_access_token` (`ig_refresh_token`) |
| Identité | `GET graph.instagram.com/me?fields=user_id,username` |
| Scope | `instagram_business_basic` **uniquement** |
| Révocation | **aucun endpoint officiel** → non implémentée, notice utilisateur |
| Identifiants | `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` (≠ App ID Facebook) |

Trois points contre-intuitifs, encodés et testés plutôt que supposés :

1. Le code d'autorisation revient avec `#_` accolé — Meta demande explicitement
   de le retirer.
2. Plusieurs réponses sont enveloppées dans un tableau `data` au lieu d'être
   à plat.
3. Le jeton issu de l'échange ne vaut qu'**une heure** : il est converti sans
   délai en jeton longue durée, seul jeton conservé dans Vault. Il n'existe
   **aucun refresh token distinct** — le jeton longue durée se rafraîchit
   lui-même, et passé 60 jours sans rafraîchissement il faut reconnecter.

Hors périmètre de C8.4a, volontairement : toute publication (Reels compris),
le scope `instagram_business_content_publish`, et Facebook.

Prérequis restants côté Meta avant validation E2E : une application Meta créée
sur `developers.facebook.com` avec le produit Instagram, un compte Instagram
professionnel de test, les URIs de redirection POSTYNC enregistrées et les
identifiants Instagram placés dans l'environnement.

---

## Sources officielles

Documentation `developers.facebook.com`, consultée le 2026-08-26 :

- Instagram Platform, présentation des configurations :
  `/docs/instagram-platform`
- Instagram API with Instagram Login :
  `/docs/instagram-platform/instagram-api-with-instagram-login`
- Business Login for Instagram (OAuth, jetons, scopes) :
  `/docs/instagram-platform/instagram-api-with-instagram-login/business-login`
- Instagram Content Publishing :
  `/docs/instagram-platform/content-publishing`
- Permission `instagram_business_content_publish` :
  `/docs/permissions/reference/instagram_business_content_publish`
- Facebook Login for Business :
  `/docs/facebook-login/facebook-login-for-business`
- Jetons longue durée, utilisateur et Page :
  `/docs/facebook-login/guides/access-tokens/get-long-lived`
- Publication de Reels sur une Page :
  `/docs/video-api/guides/reels-publishing`
- Publication vidéo sur une Page :
  `/docs/video-api/guides/publishing`
- Niveaux d'accès Standard / Advanced et Business Verification :
  `/docs/graph-api/overview/access-levels`
