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

Aucune de ces étapes n'est entamée : la configuration attend le domaine.
