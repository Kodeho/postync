# Dossier de validation — PR #9 : rétention et révocation des données YouTube

> ## ⚠️ Ce document a décrit un état faux pendant une semaine
>
> Rédigé le 2026-09-03, il annonçait « PR #9 non fusionnée » et « job pg_cron
> désactivé partout ». **Les deux étaient fausses dès le 2026-09-05.** Corrigé
> le 2026-09-10 sur mesures, et non sur souvenir. Les sections ci-dessous
> portent la date de ce qui a été réellement observé.
>
> Ce n'est pas un détail d'archivage : c'est ce document qu'un auditeur YouTube
> lirait, et l'écart entre ce qu'il affirmait et ce que faisait le système
> portait sur un mécanisme **destructif**, déjà actif en production.

État au 2026-09-10. PR #9 **fusionnée** (`0322281`, merge du 2026-09-07). Job
pg_cron `postync-youtube-retention` **ACTIF sur les deux environnements**,
cadence `17 4 * * *`. Aucun secret dans ce dossier — les vérifications qui en
manipulent le font en mémoire de processus, avec diagnostic par booléens
uniquement.

### État mesuré le 2026-09-10

| | Staging (`illwldvbunnsublcoewg`) | Production |
|---|---|---|
| Migrations `…090000`, `…150000`, `…090000` | ✅ appliquées | à confirmer par SELECT |
| Job `postync-youtube-retention` | **actif**, `17 4 * * *` | **actif** (déduit des journaux) |
| Passes observées | 6 `succeeded`, 09-05 → 09-10 | quotidiennes, dont 09-08 et 09-10 |
| Journal `retention_runs` | 7 lignes, toutes propres | s'écrit (aucune erreur de journal) |
| Purge réelle | aucune (rien d'éligible) | **1 le 2026-09-08** |

---

## 1. Vérifications faites, sur environnement réel

### 1.1 Déploiement du code sur le staging (2026-09-03)

* Déploiement git du SHA `0aa9dc8` sur le projet Vercel `postync-staging` :
  **Ready** (20 s), statut GitHub `success` à 13:19:23 UTC.
* `staging.postync.app` servi par le déploiement Production courant du projet
  staging (`dpl_3E1dbVMv6PAS22ZegbUMWkbrYQUR`, `vercel deploy` CLI, 13:20 UTC),
  vérifié par trois recoupements : identifiant `dpl_` embarqué dans le HTML
  servi (fetch frais hors cache), liste des migrations de la source déployée
  identique à `git ls-tree 0aa9dc8` (dont `20260903090000_youtube_data_retention`
  et `20260903150000_publication_platform_data_at`), et arbre de `0aa9dc8`
  strictement identique à celui de `test/staging-both` (diff vide).

### 1.2 Outillage d'essai manuel ciblé (compte YouTube de `piraino-test`)

Deux fichiers, volontairement **non commités** à ce stade :

* `tests/manual/youtube-identity-refresh.manual.test.ts` — le chemin « refresh »
  de la passe, exécuté par les modules de production (`getUsableAccessToken`
  avec `forceRefresh`, `youtubeProvider.fetchIdentity`, écritures identiques à
  `retention.ts`) sur UN compte désigné. Jamais de purge : là où la passe
  purgerait, le test s'arrête et le rapporte. Verrous : URL staging par égalité
  EXACTE, ref Production refusé nommément, client OAuth figé, chaîne attendue
  comparée (stockée ET relue) sans affichage, mode `lecture`/`refresh` séparés,
  écritures refusées sans uuid de compte explicite.
* `tests/manual/relecture-piraino.ps1` — lanceur : saisie masquée des deux
  secrets, diagnostic par booléens (vide, espaces périphériques, CR/LF,
  caractères interdits en en-tête HTTP, longueur < 30), refus AVANT tout appel
  réseau, aucune correction silencieuse, nettoyage en `finally`.

Validation **hors ligne** (valeurs factices, aucun réseau), 2026-09-03 :

* auto-test du lanceur (`-SelfTest`) : 10 cas de forme → 10 PASS, égalité
  exacte de l'URL staging vérifiée ;
* gardes du test : clé factice avec espace final → refus
  `espaces_peripheriques, caracteres_interdits_http` avant tout réseau ; URL
  avec slash final → refus `EXACTEMENT` ;
* `tsc --noEmit` propre ; sans armement le test est ignoré (`npm test`
  inoffensif), y compris avec un `POSTYNC_RETENTION_TEST_APPLY=refresh`
  résiduel (variable morte, remplacée par `..._MODE`).

### 1.3 Essais sur le compte réel `piraino-test` — RÉUSSIS

* **Passe lecture seule** : réussie le 2026-09-03 à 16:54 (heure de Paris).
  État avant lu, chaîne stockée conforme à la chaîne attendue, aucune
  écriture.
* **Passe refresh réelle** : réussie le 2026-09-03 à 14:56:19 UTC. Compte
  resté `active`, chaîne relue conforme à la chaîne attendue, jeton d'accès
  renouvelé (rotation Vault), refresh token inchangé, identité actualisée,
  zéro échec (`identity_refresh_failures = 0`), zéro purge.

La chaîne réelle d'acquisition — lecture Vault, échange Google FORCÉ
(reconfirmation III.D.2), `channels.list`, écritures du chemin refresh de la
passe — est donc éprouvée de bout en bout sur le staging, via les modules de
production. L'inventaire des écritures possibles figure dans l'en-tête du
test manuel et dans la revue du 2026-09-03.

---

## 2. Chemins réellement éprouvés vs couverts par tests automatisés

| Chemin | Réel | Automatisé | Notes |
|---|---|---|---|
| Build/déploiement du code sur staging | ✅ | — | §1.1 |
| Politique `decideRetention` / `decideAfterFailure` (7 j, 30 j, 1 h, revoked) | — | ✅ `youtube-retention.test.ts` (13 cas, fonctions pures) | |
| Câblage complet de la passe (bonne décision → bonne écriture, purge comprise) | — | ✅ `youtube-retention-flow.test.ts` (20 cas, doublures mémoire) | aucun appel Google, aucune base |
| Rotation des jetons + bascule de statut (vraie base, vrai Vault) | — | ✅ `tests/integration/token-refresh.test.ts` (12 cas, provider simulé) | l'échange Google lui-même est simulé |
| Échange RÉEL du refresh token chez Google + relecture `channels.list` | ✅ 2026-09-03 (§1.3) | — | modules de production, compte réel |
| Journal `retention_runs` : n'échoue jamais, codes contrôlés | — | ✅ `retention-journal.test.ts` | l'insert réel s'éprouve au plan §4, étape 3 |
| Détection réelle d'une révocation (`invalid_grant` vécu) | ✅ **2026-09-08, production** | partiellement (signal simulé) | journal Vercel : `google refresh: HTTP 400 invalid_grant` |
| Purge `disconnect_social_account` déclenchée par la passe | ✅ **2026-09-08, production** + ✅ staging sur fixtures | ✅ flow test + intégration | `purges=1` dans le rapport de passe |
| Purge des publications ≥ 30 j (`purgeStalePublications`) | ✅ staging, données de test | ✅ flow test + intégration | `youtube-retention-purge.test.ts` |
| Publication EN VOL épargnée (`container_id` intact) | ✅ staging, données de test | ✅ intégration | le cas qui éviterait une seconde vidéo |
| Compte neuf (`identity_refreshed_at` nul) conservé | ✅ staging, données de test | ✅ intégration | verrouille le repli sur `connected_at` |
| Route `/api/cron/retention` (401/503, rapport, journal) | ✅ chemin autorisé, quotidien | ✅ `cron-retention-route.test.ts` (7 cas) | refus et longueurs inégales couverts |
| Chaîne pg_cron → pg_net → route | ✅ **staging, 6 jours** | — | pg_cron 04:17:00 → journal 04:17:02 |
| Saturation multi-lots réelle (budget, `sature=true`) | ❌ | ✅ (flow test) | improbable à petite échelle ; reste couverte en simulation |

---

## 3. Surveillance des échecs et de la saturation

Signal retenu : **un journal en base, durable et consultable en SQL** — la
réponse JSON rendue à pg_net s'évapore avec `net._http_response`, et la ligne
`[cron:retention]` suit la rétention courte des logs Vercel.

Appliqué et fusionné depuis le 2026-09-07 (`0322281`) — la formule « préparé,
non appliqué, non commité » qui figurait ici était périmée :

* migration `supabase/migrations/20260904090000_retention_runs.sql` — table
  `retention_runs`, une ligne par invocation, service_role uniquement, RLS
  fermée. **Compteurs nullables** : `0` est une mesure, `null` veut dire
  INCONNU (invocation échouée en vol, rapport perdu, opérations partielles
  possibles) ; **`error_code` à vocabulaire fermé**, verrouillé par contrainte
  CHECK — jamais un message brut ;
* `src/server/social/retention-journal.ts` — écriture du journal aux deux
  invariants prouvés par `tests/retention-journal.test.ts` : `consignerPasse`
  n'échoue JAMAIS (erreur rendue, exception levée, client cassé — une passe
  réussie reste réussie), et `codeErreurControle` classe toute exception vers
  le vocabulaire fermé sans recopier le message ;
* `src/app/api/cron/retention/route.ts` écrit cette ligne à chaque passe,
  succès comme échec.

Consultation (Supabase → SQL editor, staging comme production) :

```sql
-- Les 14 dernières passes : saturation et échec d'invocation en un coup d'œil.
select ran_at, examined, refreshed, purged, retried,
       publications_purged, batches, saturated, duration_ms, error_code
  from retention_runs order by ran_at desc limit 14;

-- Alerte : une passe saturée ou en erreur sur les 7 derniers jours ⇒ agir.
select count(*) as alertes
  from retention_runs
 where ran_at > now() - interval '7 days'
   and (saturated or error_code is not null);

-- Le détail par compte, source de vérité des échecs de relecture.
select id, status, status_detail, identity_refresh_failures,
       identity_attempted_at, identity_refreshed_at
  from social_accounts
 where platform = 'youtube'
   and (identity_refresh_failures > 0 or status in ('error', 'revoked'));

-- ABSENCE de passe. Le journal ne peut pas signaler sa propre absence : un
-- timeout qui tue l'invocation avant l'écriture ne laisse AUCUNE ligne.
-- Passe quotidienne + marge : silence de plus de 26 h = alerte.
select coalesce(max(ran_at) < now() - interval '26 hours', true) as passe_manquante
  from retention_runs;

-- Contre-vérification côté pg_cron : le job a-t-il tiré ? Attention à la
-- lecture : `succeeded` signifie seulement que la requête HTTP a été MISE EN
-- FILE par pg_net. Job « succeeded » + journal silencieux = l'appel HTTP
-- n'aboutit pas (timeout de la route, secret, réseau) — exactement le cas que
-- `passe_manquante` attrape.
select start_time, status, return_message
  from cron.job_run_details
 where jobid = (select jobid from cron.job
                 where jobname = 'postync-youtube-retention')
 order by start_time desc
 limit 7;
```

**Ces requêtes ne sont pas des alertes automatiques.** Rien ni personne n'est
notifié : si personne ne les exécute, un incident — y compris une passe
manquante — reste invisible. La surveillance est donc une CONSULTATION, avec
un responsable et un rythme nommés :

* **qui** : l'opérateur (Ludovic), depuis le SQL editor du projet concerné ;
* **quand** : quotidiennement la première semaine suivant chaque activation de
  cron (staging puis production), puis chaque lundi ;
* **quoi** : les cinq requêtes ci-dessus, détection d'absence comprise.

Le signal réellement REÇU (e-mail d'alerte) passerait par la couche
`email_deliveries`, dont le fournisseur (Scaleway TEM, décision du 2026-08-28)
attend le domaine définitif : suite distincte, à ouvrir après la livraison.

---

## 4. Livraison — constat, et non plus plan

Ce chapitre était un plan en sept étapes, chacune « derrière une autorisation ».
Il est remplacé par ce qui a été **mesuré le 2026-09-10**, parce qu'un plan qui
décrit un futur déjà advenu n'informe personne.

| Étape prévue | État réel |
|---|---|
| 1. Essais réels staging | ✅ 2026-09-03 (§1.3) |
| 2. Commit de la surveillance | ✅ fusionné le 2026-09-07 (`0322281`) |
| 3. Staging — migration + invocation manuelle | ✅ migrations appliquées ; une invocation le 2026-09-04 à 11:19 UTC |
| 4. Staging — activation du cron | ✅ actif ; première passe automatique le 2026-09-05 |
| 5. Production — migrations | ✅ (déduit : la passe y écrit son journal sans erreur) |
| 6. Fusion de la PR #9 | ✅ 2026-09-07 |
| 7. **Production — activation du cron** | ✅ **effectuée, sans autorisation tracée** |

L'étape 7 exigeait « une autorisation séparée ». Rien dans ce dossier, dans
l'historique Git ou dans les journaux ne conserve la trace de cette décision.
`cron.job_run_details` n'enregistre pas l'auteur d'un `alter_job`. **La question
« qui a activé le job de production, et quand » restera donc sans réponse**, et
il vaut mieux l'écrire que l'inventer.

### 4.1 Incident du 2026-09-08 — une purge réelle, passée inaperçue

Journal Vercel du projet `postync` (production), 04:17:00 UTC :

```
POST /api/cron/retention 200
[social:token] youtube refresh: google refresh: HTTP 400 invalid_grant
[retention] lots=1 examines=1 rafraichis=0 purges=1 reessais=0 publications=0 sature=false
[cron:retention] examines=1 rafraichis=0 purges=1 reessais=0 publications=0
```

Lecture : un compte YouTube de production a vu son refresh token refusé par
Google avec `invalid_grant` — le signal documenté d'une autorisation retirée.
`decideAfterFailure` l'a classé `auth_revoked`, `disconnect_social_account` a
purgé le compte et les données de plateforme de ses publications. La passe du
2026-09-10 rapporte `examines=0` : il ne reste aucun compte YouTube en
production.

**Le mécanisme a fait exactement ce que les Developer Policies exigent.** C'est
la meilleure preuve de conformité dont dispose ce dossier, et elle est
involontaire.

Ce qui doit être retenu, en revanche, est que **personne ne l'a su.** Ni
l'activation du job, ni la suppression d'un compte utilisateur n'ont produit le
moindre signal reçu par un humain. Il a fallu lire les journaux Vercel une
semaine plus tard, en préparant l'audit, pour les découvrir. C'est l'argument
qui justifie la surveillance du §3 — et sa faiblesse actuelle.

### 4.2 Retour arrière

Inchangé, et toujours valable : tout signal anormal (purges inattendues,
saturation, `error_code`, passe manquante) ⇒ **désactiver le job d'abord**,
analyser ensuite.

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'postync-youtube-retention'),
  active := false);
```

Une commande, aucun déploiement. Le code se retire par Instant Rollback Vercel.
**Les purges sont irréversibles** — c'est la raison de l'ordre « couper puis
comprendre ».

⚠️ Contrepartie à connaître avant de couper : le job éteint, POSTYNC cesse de
reconfirmer les jetons et de purger les données au-delà de 30 jours, donc sort
de la conformité III.D.2 / III.E.4.c. Une coupure est un geste d'urgence, pas
un état de repos — elle se documente et se referme.
