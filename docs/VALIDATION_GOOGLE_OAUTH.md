# Dossier de validation — Google OAuth puis audit YouTube API Services

État au 2026-09-10, **relevé dans la console** (projet `postync`, numéro
`71307782821`).

Aucun secret dans ce dossier. Les `client_secret` ne sont plus affichables par
la console elle-même ; seuls les identifiants publics y figurent.

---

## 0. Les deux procédures, dans l'ordre

Distinctes et **en série**.

| | Vérification OAuth | Audit YouTube API Services |
|---|---|---|
| Qui | Google Trust & Safety | équipe YouTube API Services |
| Débloque | l'écran de consentement sans le plafond de 100 utilisateurs | l'usage de l'API au-delà du quota par défaut |
| Quand | maintenant | **après** la vérification OAuth |

---

## 1. État relevé dans la console le 2026-09-10

### 1.1 Audience

| | |
|---|---|
| État de publication | **En production** |
| Type d'utilisateur | **Externe** |
| Plafond OAuth | **3 utilisateurs / 100 maximum** |

Le plafond « s'applique pour la durée de vie complète du projet et ne peut être
ni réinitialisé, ni modifié ». Trois places sont consommées.

### 1.2 Branding — validé, et conforme aux pages en ligne

| Champ | Valeur en console | Page vérifiée en ligne |
|---|---|---|
| Nom de l'application | `POSTYNC` | — |
| Adresse d'assistance | `dev@kodeho.com` | — |
| Logo | présent | — |
| Page d'accueil | `https://postync.app` | ✅ en ligne |
| Règles de confidentialité | `https://postync.app/privacy` | ✅ en ligne |
| Conditions d'utilisation | `https://postync.app/terms` | ✅ en ligne |
| Domaine autorisé | `postync.app` | couvre `app.` et `staging.` |
| Contact développeur | `dev@kodeho.com` | — |

État : « Votre branding a été validé et est visible par les utilisateurs. »

### 1.3 Clients OAuth — il y en a DEUX

| Nom | Créé le | URI de redirection |
|---|---|---|
| `POSTYNC web` | 21 août 2026 | `http://localhost:3000/...`, `http://localhost:3077/...`, `https://app.postync.app/api/oauth/youtube/callback` |
| `POSTYNC Verification Staging` | 2 sept. 2026 | `https://staging.postync.app/api/oauth/youtube/callback` |

⚠️ **Conséquence directe sur la vidéo.** La console l'écrit noir sur blanc :
« Votre vidéo doit inclure **l'ensemble des clients OAuth** que vous avez
affectés à ce projet. » Une vidéo qui ne montrerait que le staging est
incomplète. Voir §4.2 pour la manière de couvrir les deux sans brûler de place.

⚠️ Deux URI `http://localhost` subsistent sur le client de **production**.
Google les tolère (localhost est exempté de l'obligation HTTPS), mais elles
attirent parfois un commentaire d'examen. Les retirer casserait le
développement local — décision à prendre en connaissance de cause, pas par
réflexe.

### 1.4 Accès aux données — les deux scopes sont SENSIBLES

| Section | Contenu |
|---|---|
| Non sensibles | *aucune ligne* |
| **Sensibles** | `.../auth/youtube.readonly` — « Afficher votre compte YouTube » |
| | `.../auth/youtube.upload` — « Gérer vos vidéos YouTube » |
| **Restreints** | *aucune ligne* |

**Correction d'une hypothèse antérieure :** `youtube.upload` avait été supposé
**restreint**, ce qui aurait entraîné une évaluation de sécurité tierce (CASA).
La console le classe **sensible**. La section « restreints » est vide.
**Aucune évaluation CASA n'est donc à prévoir.**

Les deux scopes déclarés sont exactement ceux que le code demande
(`YOUTUBE_SCOPES` dans `src/server/social/providers/youtube.ts`), ni plus,
ni moins.

### 1.5 Centre de validation — SOUMIS le 2026-09-10

> **« L'accès aux données de votre application est en cours d'examen. »**

Soumission envoyée le 2026-09-10. Contenu : les deux scopes, la justification
(901 car.), la vidéo `https://youtu.be/907-coRYO_w` et les informations
supplémentaires (944 car.).

Questionnaire de validation, répondu **Non** aux quatre questions : usage
personnel, usage interne, développement/test/préproduction, plug-in SMTP Gmail
pour WordPress. Les deux attestations (lecture des conditions de soumission,
prise de connaissance de la règle CASA) ont été cochées par l'éditeur
lui-même — elles engagent sa signature, pas celle d'un agent.

Avant la soumission, le seul blocage restant était la vidéo : le message
« Les champs suivants sont manquants […] : vidéo de démonstration » et le
bouton « Confirmer » grisé ont tous deux disparu dès le lien renseigné.

---

## 2. Les deux scopes, et la conséquence de les toucher

### `youtube.readonly` — sensible

Un seul appel : `channels.list?part=snippet&mine=true`, dans
`youtubeProvider.fetchIdentity`. Lit `id`, `snippet.title`,
`snippet.thumbnails.default.url`.

**Le retirer :** `videos.insert` fonctionnerait encore, mais POSTYNC ne saurait
plus sur quelle chaîne il publie, ne pourrait plus l'afficher, et ne
détecterait plus le cas « compte Google sans chaîne »
(`youtubeSignupRequired`) — qui deviendrait un échec d'envoi opaque au lieu
d'un message clair à la connexion. La passe de rétention
(`src/server/social/retention.ts`) s'en sert aussi pour reconfirmer
périodiquement la validité du jeton (Developer Policy III.D.2) : sans lui,
la reconfirmation n'a plus d'appel à faire.

### `youtube.upload` — sensible

Un seul appel : `videos.insert` en upload résumable
(`youtube-publisher.ts`). C'est le **plus étroit** qui autorise
`videos.insert` — `youtube`, `youtube.force-ssl` et `youtubepartner`
l'autorisent aussi mais ouvrent bien davantage.

**Le retirer :** la publication YouTube disparaît. C'est la fonction du produit.

> Aucun scope n'a été ajouté, retiré ni modifié.

---

## 3. Justification des scopes — SAISIE ET ENREGISTRÉE

Page **Accès aux données**, champ « Comment seront utilisés ces niveaux
d'accès ? ». **901 / 1000 caractères.** Enregistrée le 2026-09-10
(« Modifications de l'accès aux données enregistrées. »).

```text
POSTYNC is a scheduling tool: a creator writes a post once and publishes it to their own connected accounts (YouTube, Instagram, Facebook, TikTok).

youtube.readonly - called once, right after the user grants access, as channels.list(part=snippet, mine=true). We read only the channel id, title and thumbnail, so the user can see which channel they are about to publish to, and so we can detect a Google account that owns no channel. We never read their other videos, analytics, playlists, comments or subscribers.

youtube.upload - called only as videos.insert (resumable upload), to publish a video the user has explicitly scheduled, with the title, description, privacy status (public / unlisted / private) and made-for-kids declaration they chose in our interface.

Neither call has a narrower scope available. Tokens are stored encrypted; on disconnect we revoke them with Google and delete them.
```

---

## 4. Vidéo de démonstration

### 4.1 Exigences, relevées dans la console et dans la doc Google

1. **En anglais.**
2. Publiée sur YouTube en **non répertoriée**, ouvrable sans connexion.
3. **Barre d'adresse visible**, `client_id` lisible pendant le consentement.
4. Chaque scope montré **en usage réel**, pas en capture.
5. **Tous les clients OAuth du projet** couverts (ils sont deux, §1.3).
6. L'écran **« Appli non validée » doit être montré** — la console le dit
   explicitement : « Cela est normal et doit être montré dans la vidéo. »

### 4.2 Environnement — et comment couvrir les deux clients sans coût

La console recommande de ne pas déployer de scopes non validés sur le trafic de
production, et propose la préproduction ou un projet de test.

**Plan retenu :** enregistrer l'essentiel sur `staging.postync.app` (client
`POSTYNC Verification Staging`), puis ajouter un court segment sur
`app.postync.app` (client `POSTYNC web`) pour satisfaire l'exigence n° 5.

> **Astuce qui évite de brûler une place :** le plafond compte des
> *utilisateurs*, pas des connexions. Utiliser pour le segment production
> **l'un des 3 comptes Google déjà comptabilisés** ne consomme aucune place
> supplémentaire. Ne jamais y connecter un compte Google neuf.

Prévoir : un compte POSTYNC de test, un compte Google de test possédant une
chaîne, un fichier vidéo court (< 20 Mo).

`GOOGLE_OAUTH_HL=en` est posé sur le projet Vercel staging le temps de
l'enregistrement (variable lue à l'exécution, aucune reconstruction requise —
`consentLanguage()` dans `youtube.ts`).

### 4.3 Découpage, plan par plan

| # | Durée | À l'écran | À dire (anglais) |
|---|---|---|---|
| 1 | 0:00–0:15 | `postync.app` | "This is POSTYNC, a social media scheduling tool. A creator writes a post once and publishes it to their own connected accounts." |
| 2 | 0:15–0:30 | `/privacy`, section YouTube | "Our privacy policy names the YouTube API Services and links to Google's privacy policy and to the Google security settings page where access can be revoked." |
| 3 | 0:30–0:40 | `/terms`, section 3 | "Our terms state that users agree to be bound by the YouTube Terms of Service." |
| 4 | 0:40–0:55 | `staging.postync.app`, connexion | "I sign in to my POSTYNC account on our pre-production environment." |
| 5 | 0:55–1:05 | Comptes sociaux, aucun YouTube | "No YouTube channel is connected yet. I click Connect." |
| 6a | 1:05–1:15 | **« Choose an account »** — s'arrêter une seconde, `client_id=` est lisible en début d'URL | "You can see the client ID in the address bar. I pick my test account." |
| 6b | 1:15–1:25 | **« Google hasn't verified this app »** → Advanced → Go to POSTYNC (unsafe) | "This is the unverified app screen, shown because these scopes are not approved yet. I continue." |
| 7 | 1:25–1:45 | consentement : **cocher « Select all »**, les deux scopes apparaissent cochés | "POSTYNC requests exactly two scopes: youtube dot readonly, to read the channel identity, and youtube dot upload, to publish the video. I grant both." — lire les deux libellés à voix haute |
| 8 | 1:45–2:00 | la chaîne s'affiche (nom + avatar) | "**This is youtube.readonly in use.** We called channels.list with mine=true, once, to read the channel id, title and thumbnail — so the user sees which channel they will publish to. We read nothing else." |
| 9 | 2:00–2:20 | **« Publier » dans le menu de gauche**, choisir le média, cocher le réseau YouTube | "Now I compose a post. I pick a video file and select my YouTube channel." |
| 10 | 2:20–2:45 | les champs YouTube apparaissent : **Titre**, puis les 3 visibilités en boutons radio (Privée / Non répertoriée / Publique), Contenu destiné aux enfants (Oui/Non), certification Guidelines | "The user chooses the privacy status — private, unlisted or public. Nothing is forced. The user also declares whether the video is made for kids, and certifies compliance with the YouTube Community Guidelines." |
| 11 | 2:45–3:05 | publier, progression de l'envoi | "**This is youtube.upload in use.** We call videos.insert with a resumable upload. This is the only write we ever perform." |
| 12 | 3:05–3:20 | le lien dans l'historique → la vidéo sur YouTube | "The video is on the channel, with exactly the privacy status the user chose." |
| 13 | 3:20–3:40 | « Déconnecter » | "When the user disconnects, we ask Google to revoke the token immediately, and we delete the tokens and the channel data on our side in the same operation — whether or not Google's revocation call succeeds." |
| 14 | 3:40–3:50 | `security.google.com/settings/security/permissions` : POSTYNC absent | "The access is gone from the user's Google account." |
| 15 | 3:50–4:15 | **`app.postync.app`**, connexion du compte Google DÉJÀ comptabilisé, arrêt sur le consentement, barre d'adresse lisible | "This is our second OAuth client, POSTYNC web, used in production. It requests exactly the same two scopes." |

Durée visée : **4 à 4 min 30**.

### 4.3 bis — Pièges relevés en répétant le parcours le 2026-09-10

* **Ne pas utiliser le formulaire rapide** de la fiche du compte (« Publier
  sur … » sous Comptes sociaux) : il n'affiche ni titre, ni visibilité, ni
  déclaration made-for-kids, ni certification Guidelines. Les champs que
  l'examinateur doit voir ne vivent que sur l'écran **Publier** du menu de
  gauche, une fois le réseau YouTube coché.
* **Déconnecter la chaîne avant de tourner.** Le plan 5 montre l'état « aucun
  compte connecté » ; sans lui, l'apparition de la chaîne au plan 8 ne prouve
  rien.
* **L'interface POSTYNC reste en français.** `GOOGLE_OAUTH_HL` n'agit que sur
  l'écran de consentement Google. Il faut donc énoncer en anglais, à voix
  haute, ce que montre chaque champ — en particulier les trois visibilités.
* Le consentement Google présente les scopes en **cases à cocher
  décochées** : penser à cocher « Select all », sinon l'autorisation est
  partielle.
* **LE PIÈGE QUI RUINE UNE PRISE.** Si le compte Google a DÉJÀ accordé les
  scopes, l'écran de consentement ne les montre plus du tout : il affiche
  « POSTYNC already has some access — See the 2 services », sans aucune case à
  cocher. L'examinateur ne verrait donc jamais les deux scopes être accordés.
  Constaté le 2026-09-10.
  **Avant toute prise du plan 7 :** déconnecter dans POSTYNC, PUIS vérifier sur
  `security.google.com/settings/security/permissions` que POSTYNC n'y figure
  plus — la révocation est faite au mieux et peut échouer. Retirer l'entrée à
  la main si elle subsiste.
* **Où filmer le `client_id`.** Sur l'écran **« Choose an account »**,
  `client_id=` est le DEUXIÈME paramètre de l'URL, donc lisible sans rien
  manipuler. Sur l'écran de consentement suivant, l'URL fait plusieurs milliers
  de caractères et `client_id` se trouve à la toute fin : impossible à montrer
  proprement. Filmer le premier, pas le second.

### 4.4 À ne pas faire

- couper au montage pendant le consentement ;
- masquer ou flouter la barre d'adresse ;
- montrer un `client_secret`, un jeton ou le contenu de `.env` ;
- enregistrer en français ;
- publier la vidéo en `private` — Google ne pourrait pas l'ouvrir ;
- connecter un compte Google **neuf** sur la production (une place perdue à vie).

---

## 4 bis. Incident du 2026-09-10 — `invalid_client` sur le staging, RÉSOLU

**Symptôme :** « La plateforme n'a pas finalisé la connexion » à chaque
tentative de connexion YouTube sur `staging.postync.app`, après un écran de
consentement pourtant normal.

**Journal Vercel (`postync-staging`), 4 occurrences :**

```
[oauth:youtube] échange: google token: HTTP 401 invalid_client
```

**Cause racine :** `GOOGLE_CLIENT_SECRET` du projet Vercel `postync-staging`
ne correspondait pas au `GOOGLE_CLIENT_ID` du même environnement. L'identifiant
pointait bien sur le client `POSTYNC Verification Staging` — d'où un
consentement qui s'affichait normalement — mais le secret associé était le
mauvais. Même piège que celui déjà rencontré avec TikTok : deux paires
clé/secret d'apparence identique, dont on mélange les moitiés.

**Ce que l'incident enseigne sur le diagnostic.** `exchange_failed` est renvoyé
depuis **cinq** endroits de `callback.ts` (l. 114, 136, 143, 159, 216) : échange
du code, brouillon, provider sans identité, `fetchIdentity`, `upsert`. Le
message affiché est le même dans tous les cas. **Ne jamais conclure sans le
journal** — seul `[oauth:youtube] échange: …` désigne la ligne fautive.

**Correction :** nouveau secret généré sur le client staging (rotation, sans
coupure), posé dans `GOOGLE_CLIENT_SECRET`, puis redéploiement Production du
projet staging (`DiZJxFfM9`, Ready en 43 s).

**Vérification de bout en bout, 2026-09-10 :** consentement en anglais, deux
scopes cochés, retour sur `?connected=youtube`, chaîne « Ludovic PIRAINO »
affichée avec jeton valide, écran Publier proposant titre, 3 visibilités,
made-for-kids et certification. Plafond OAuth **inchangé à 3/100** — la
reconnexion d'un compte déjà comptabilisé ne consomme pas de place.

---

## 5. Informations supplémentaires — SAISIE, à re-saisir au moment de la soumission

Champ facultatif du formulaire de soumission. **847 / 1000 caractères.**
Il appartient au corps de la soumission : quitter la page sans confirmer le
perd. Le voici pour le recoller.

Version définitive, **944 / 1000 caractères**. Elle dit que la démonstration se
déroule en préproduction ET qu'un court segment final montre le client de
production — la première rédaction passait ce segment sous silence, ce qu'un
examinateur comparant la vidéo à la déclaration aurait relevé.

```text
This project has two OAuth clients, both shown in the demo video:

- "POSTYNC web" - production, redirect https://app.postync.app/api/oauth/youtube/callback
- "POSTYNC Verification Staging" - pre-production, redirect https://staging.postync.app/api/oauth/youtube/callback

The full walkthrough is recorded on the pre-production environment (staging.postync.app), following your guidance not to serve unverified scopes to production traffic. A short final segment shows the production client's consent screen, so that both clients are covered. The "unverified app" screen is visible in the recording.

A free plan is available, so reviewers can sign up at https://app.postync.app/signup and reach the YouTube connection and publishing screens. A dedicated test account can be provided on request at dev@kodeho.com.

POSTYNC also publishes to Instagram, Facebook and TikTok. Those integrations use their own APIs and never touch Google user data.
```

---

## 6. Après la soumission OAuth — audit YouTube API Services

À n'engager **qu'une fois la vérification OAuth obtenue**.

### 6.1 Déjà en place, à citer dans le formulaire

| Exigence | Implémentation |
|---|---|
| RMF — 3 visibilités au choix | `src/lib/youtube-metadata.ts` (`YOUTUBE_PRIVACY_STATUSES`), `broadcast-form.tsx` |
| Made-for-kids, jamais de défaut | `parseYouTubeMetadata` refuse `null` (COPPA) |
| Certification Guidelines horodatée | `guidelinesAcknowledgedAt` |
| Lien CGU YouTube + acceptation | `/terms` §3 |
| Politique Google liée | `/privacy` §5 |
| Panneau de révocation Google lié | `/privacy` §5 |
| Suppression à la révocation | `disconnectSocialAccount`, trigger `social_accounts_purge_secrets` |
| Rétention ≤ 30 j (III.E.4.c) | `src/server/social/retention.ts` |
| Reconfirmation des jetons (III.D.2) | idem |
| Journal consultable | `retention_runs`, `retention-journal.ts` |

### 6.2 État réel du mécanisme de rétention (mesuré le 2026-09-10)

⚠️ **Ce document affirmait que le cron était « inactif partout ». C'était
faux.** Il tourne quotidiennement à 04:17 sur les DEUX environnements.

| Constat | Preuve |
|---|---|
| Staging : job `active = true`, `17 4 * * *` | `cron.job` |
| Staging : 6 passes `succeeded` du 09-05 au 09-10 | `cron.job_run_details` |
| Staging : 7 lignes de journal, toutes propres | `retention_runs` |
| Chaîne pg_cron → pg_net → route → journal | corrélation 04:17:00 → 04:17:02, six jours |
| **Production : passe du 2026-09-08, `purges=1`** | journal Vercel `postync` |
| Production : révocation réelle détectée (`invalid_grant`) | idem |

La purge réelle et la détection d'une révocation vécue — les deux chemins qui
manquaient — sont donc **éprouvés en production**, quoique sans que
l'activation ait suivi le processus d'autorisation prévu.

### 6.2 bis À faire avant de soumettre l'audit

1. **Éprouver ce qui reste** : purge des publications ≥ 30 j, saturation
   multi-lots, branches 401/503 de la route.
2. **Vérifier la production** : `retention_runs` s'y remplit-il, et reste-t-il
   des publications porteuses de données de plateforme au-delà de 30 jours ?
3. **Mettre en place une surveillance** — aujourd'hui, aucune alerte n'est
   reçue par personne. C'est le point faible principal, et il est d'autant plus
   sensible que le mécanisme est destructif et déjà actif.
4. **Corriger les commentaires périmés** (§6.3).
5. **Surveiller le quota** Google à chaque passe qui relit des identités.

### 6.3 Affirmations périmées dans le dépôt

**Corrigées le 2026-09-10 :**

- `src/server/social/providers/youtube.ts` — disait « consent screen en statut
  Testing ». L'app est en Production depuis le 2026-09-01, et la règle des
  7 jours sur les refresh tokens ne s'applique donc plus (documentation Google
  revérifiée : elle ne vaut QUE pour le statut Testing avec type externe).
- `src/app/page.tsx` — mêmes deux affirmations, plus « `privacyStatus` forcé à
  `private` », démentie par la mesure du 2026-09-02.

**Restant à corriger :**

- `docs/YOUTUBE_COMPLIANCE.md` : sections « `privacyStatus` forcé à `private` »
  et « acceptation des CGU non historisée » (fausse depuis la PR #7,
  `legal_acceptances`).
- `docs/VALIDATION_PR9_RETENTION.md` : « PR #9 non fusionnée » (elle l'est,
  `0322281`), et tout le §2 dont plusieurs ❌ sont en réalité prouvés — voir
  §6.2 ci-dessus.
- `README.md` : boilerplate Next.js, aucune information de conformité. Hors
  périmètre tant qu'il ne porte pas d'affirmation fausse.
