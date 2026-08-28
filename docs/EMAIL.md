# Courriel transactionnel

Décision d'architecture prise le **2026-08-28** : POSTYNC envoie ses courriels
transactionnels via **Scaleway Transactional Email (TEM)**.

## Pourquoi ce choix

Trois candidats convenaient réellement — Brevo, Scaleway TEM et Amazon SES —
après élimination de Postmark (aucune résidence UE, 100 courriels par mois sur
l'offre gratuite) et de Mailgun (un seul domaine et un jour de rétention des
logs sur les offres basses, ce qui rend un flux d'authentification difficile à
déboguer).

Scaleway TEM l'emporte sur **un seul critère décisif** : c'est le seul dont le
fournisseur déclare explicitement n'employer **aucun sous-traitant hors UE**
pour ce service, et n'exiger **aucune analyse d'impact de transfert**. Les
données restent dans la région `fr-par`.

Ce critère pèse lourd ici parce que POSTYNC est édité par une micro-entreprise
française et que sa politique de confidentialité documente déjà précisément ses
sous-traitants. Ajouter un destinataire hors UE aurait imposé de la modifier,
d'inscrire un transfert au registre des traitements et de s'appuyer sur des
clauses contractuelles types — pour un service qui, à l'échelle de POSTYNC,
coûte quelques centimes par mois.

Contreparties acceptées :

- quota par défaut de 10 000 courriels par mois, relevable sur demande ;
- facturation **par destinataire** — une copie compte pour un envoi ;
- service réservé au transactionnel, le marketing y est interdit. Sans
  conséquence : POSTYNC n'envoie que du transactionnel.

## Ce que cela répare

| Courriel | Émis par | Aujourd'hui |
| --- | --- | --- |
| Confirmation d'inscription | Supabase Auth | service intégré Supabase |
| Réinitialisation de mot de passe (C15) | Supabase Auth | service intégré Supabase |
| Invitation d'équipe (C14) | POSTYNC | **rien** — lien à copier à la main |

Le service intégré de Supabase est plafonné à **2 courriels par heure**, en
« best-effort », et sa documentation le déclare inadapté à la production. Les
deux premières lignes en dépendent donc aujourd'hui : POSTYNC ne peut pas
accueillir plus de deux inscriptions par heure. **Un SMTP dédié est un
prérequis de mise en production, pas un confort.**

Un SMTP personnalisé porte par ailleurs le plafond Supabase à 30 courriels par
heure par défaut, ajustable.

## Deux chemins d'envoi, volontairement distincts

**Supabase Auth → SMTP.** Confirmation et réinitialisation sont émises par
Supabase, pas par POSTYNC. Elles se règlent par **configuration du projet**
(hôte, port, identifiants, expéditeur) : aucun code applicatif n'est en jeu.

**Invitations → API HTTP de Scaleway.** POSTYNC compose et envoie lui-même ce
message, puisqu'il en fabrique le lien. L'API HTTP est préférée au SMTP pour
ce chemin : elle évite d'ajouter un client SMTP aux dépendances et se comporte
mieux en environnement sans état, où maintenir une connexion SMTP n'a pas de
sens.

## L'architecture, telle qu'elle est construite

```
src/server/email/
  config.ts              expéditeur, reply-to, région, clé — tout depuis l'environnement
  failure.ts             classification des échecs (pur, testé seul)
  scaleway.ts            transport : un appel HTTP, un délai borné, rien d'autre
  send.ts                POINT D'ENTRÉE UNIQUE : idempotence, réessai, journal
  notifications.ts       les courriels du produit : composer + choisir la clé
  templates/
    layout.ts            coquille commune, HTML de messagerie + version texte
    invitation.ts        invitation d'équipe (C14)
    security.ts          notification de changement de mot de passe (C15)
```

**Rien n'appelle Scaleway directement.** Tout passe par `sendTransactionalEmail`,
ce qui permet de tenir en un seul endroit les trois règles qu'on n'applique
jamais deux fois de la même façon si on les écrit deux fois : l'idempotence, la
politique de réessai, et ce que le journal a le droit de contenir.

**Ajouter un courriel au produit** = une fonction dans `notifications.ts` et un
gabarit à côté. Rien d'autre ne bouge.

### Idempotence

`email_deliveries` porte un index unique sur la clé d'idempotence, et la ligne
est **insérée AVANT l'envoi**. Si l'insertion échoue en `23505`, un envoi pour
cette même cause a déjà eu lieu — ou est en cours dans une autre requête — et
rien n'est réexpédié. Vérifier puis insérer laisserait la fenêtre habituelle
entre les deux, et une Server Action *peut* être rejouée : double clic, reprise
réseau, nouvelle tentative du navigateur.

| Courriel | Clé | Stabilité |
| --- | --- | --- |
| Invitation | `invitation:<id>` | parfaite — un renvoi crée une NOUVELLE invitation, donc une nouvelle clé |
| Mot de passe modifié | `password-changed:<userId>:<minute>` | seau d'une minute — compromis assumé, pas une idempotence parfaite |

### Réessai

On ne réessaie que ce qui **ne dépend pas de ce qu'on a envoyé** : réseau,
délai dépassé, 5xx, 429. Trois tentatives, attente doublée à chaque fois.

Jamais de réessai sur `unauthorized` (une clé invalide le restera) ni sur
`rejected` (une adresse refusée ou un domaine non authentifié ne se répare pas
en insistant). Réessayer un échec définitif retarde le message d'erreur,
consomme le quota, et peut expédier **deux fois** si la première tentative avait
en réalité abouti.

### Journal

`email_deliveries` n'est accessible à aucune session — ni grant, ni politique,
comme `oauth_states`. Elle ne stocke **ni le corps du message, ni aucun lien** :
une invitation porte un jeton, et POSTYNC a pris soin de n'en garder que
l'empreinte ; l'écrire dans un journal annulerait ce soin d'un trait.

Les traces `console` ne portent que l'identifiant de la ligne, le nom du
gabarit et un code d'échec. Le détail nécessaire au diagnostic vit dans la
table, protégée.

### Dégradation tant que le domaine n'existe pas

Sans configuration, `sendTransactionalEmail` répond `not_configured` — ni
erreur, ni exception : c'est l'état normal du produit aujourd'hui. Les
invitations se rabattent alors sur le lien à copier, exactement comme avant.
Le jour où le domaine est authentifié, **le même code** envoie le message et
cesse d'afficher le lien. Aucun drapeau à basculer, aucune branche morte à
maintenir.

Un échec d'envoi n'annule jamais l'invitation : elle existe en base, son lien
est valide. La détruire parce qu'un service tiers est indisponible ferait
perdre l'action de l'utilisateur.

## Configurer Supabase Auth en SMTP Scaleway — préparé, NON appliqué

La confirmation d'inscription et la réinitialisation de mot de passe sont
émises par Supabase, pas par POSTYNC : elles se règlent par configuration du
projet, sans code.

Paramètres SMTP Scaleway TEM :

| Champ | Valeur |
| --- | --- |
| Hôte | `smtp.tem.scaleway.com` |
| Port | `587` (STARTTLS) — aussi `465`/`2465` en TLS implicite, `25`/`2587` |
| Utilisateur | l'**identifiant du projet** Scaleway (`SCW_PROJECT_ID`) |
| Mot de passe | la **clé API secrète** du projet (`SCW_SECRET_KEY`) |
| Expéditeur | une adresse du domaine **authentifié** |

Source : [Setting up SMTP — documentation Scaleway](https://www.scaleway.com/en/docs/transactional-email/reference-content/smtp-configuration/).

Les mêmes identifiants servent donc à l'API HTTP et au SMTP : une seule clé à
créer, une seule à renouveler.

**Ne pas appliquer avant que le domaine soit authentifié.** Une bascule
prématurée casserait l'inscription et la récupération de mot de passe, qui
fonctionnent aujourd'hui via le service intégré — dégradé, mais fonctionnel.
Un SMTP personnalisé porte par ailleurs le plafond Supabase de 2 à 30 courriels
par heure, ajustable ensuite.

## Ce qui reste à faire, et dans quel ordre

1. **Choisir le domaine d'envoi.** ⛔ *Bloquant, décision en attente.*
   POSTYNC est servi sur `postync.vercel.app` : la zone DNS de `vercel.app`
   n'est pas la nôtre, donc **ni SPF ni DKIM ne peuvent y être posés**, et sans
   eux les messages partent en indésirables ou sont rejetés. Il faut un domaine
   possédé — un sous-domaine de `kodeho.com`, ou un domaine propre à POSTYNC.
   Un domaine propre imposerait en outre de mettre à jour les `redirect_uri`
   déclarés chez Meta et TikTok.
2. Créer le domaine dans Scaleway TEM et poser les enregistrements DNS
   (SPF et DKIM obligatoires, MX fortement recommandé), puis déclencher la
   vérification.
3. Configurer le SMTP du projet Supabase.
4. Écrire l'envoi des invitations et remplacer le lien à copier.
5. E2E réels sur les trois courriels.

Les étapes 4 et « couche d'envoi » sont FAITES et testées. Restent 1, 2, 3 et
5 — toutes suspendues au domaine.

### Ce qui est déjà en place

- couche d'envoi centralisée, idempotente, avec réessai borné ;
- gabarits invitation et notification de sécurité, responsive, testés ;
- invitations C14 branchées, avec repli sur le lien tant que l'envoi est
  indisponible ;
- notification de changement de mot de passe branchée sur les deux chemins de
  C15 (réinitialisation et changement depuis les paramètres) ;
- variables d'environnement documentées dans `.env.example`.

### Ce qui attend le domaine

- authentification du domaine chez Scaleway (SPF, DKIM, DMARC) ;
- adresse d'expédition définitive dans `EMAIL_FROM_ADDRESS` ;
- bascule SMTP du projet Supabase ;
- E2E réels sur les trois courriels.
