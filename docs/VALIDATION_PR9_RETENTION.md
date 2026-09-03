# Dossier de validation — PR #9 : rétention et révocation des données YouTube

État au 2026-09-03. PR #9 **non fusionnée**, branche `feat/youtube-data-retention`
au SHA `0aa9dc8`. Job pg_cron `postync-youtube-retention` **désactivé** partout
(créé `active := false` par la migration `20260903090000`). Aucun secret dans ce
dossier — les vérifications qui en manipulent le font en mémoire de processus,
avec diagnostic par booléens uniquement.

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
| Détection réelle d'une révocation (`invalid_grant` vécu) | ❌ | partiellement (signal simulé) | exigerait une révocation Google — non prévue |
| Purge `disconnect_social_account` déclenchée par la passe | ❌ | ✅ (flow test) | volontairement exclue des essais réels |
| Purge des publications ≥ 30 j (`purgeStalePublications`) | ❌ | ✅ (flow test) | le cas réel exigerait des dates anciennes authentiques |
| Route `/api/cron/retention` (secret partagé, 401/503, rapport) | ❌ | partiellement (`use-server-exports`, revue) | à éprouver au plan §4, étape 2 |
| Chaîne pg_cron → pg_net → route | ❌ | — | ne s'éprouve qu'en activant le job (staging d'abord) |
| Saturation multi-lots réelle (budget, `sature=true`) | ❌ | ✅ (flow test) | improbable à petite échelle |

---

## 3. Surveillance des échecs et de la saturation

Signal retenu : **un journal en base, durable et consultable en SQL** — la
réponse JSON rendue à pg_net s'évapore avec `net._http_response`, et la ligne
`[cron:retention]` suit la rétention courte des logs Vercel.

Préparé (non appliqué, non commité) :

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

## 4. Plan de livraison Production — chaque étape derrière une autorisation

Rien ne s'exécute sans accord explicite. **Les migrations précèdent la
fusion** : le code fusionné lit `platform_data_at` et écrit `retention_runs` —
le déployer sur une base qui ne les porte pas casserait la passe et le
planificateur au premier réveil. L'inverse est sans danger : ces migrations
sont additives (colonnes et table nouvelles, job créé DÉSACTIVÉ) et inertes
pour le code actuellement en production.

1. ~~Essais réels staging~~ — **fait** (§1.3).
2. **Commit de la surveillance** sur la branche (module journal, route,
   migration, tests) après revue.
3. **Staging — migration + contrôle de la route** : appliquer
   `20260904090000_retention_runs` au staging ; déployer la branche ; UNE
   invocation manuelle de `POST /api/cron/retention` avec le secret.
   Attention : c'est la passe COMPLÈTE — inventorier d'abord les comptes
   staging purgeables (`revoked`, ou > 30 j en échec). Critères : HTTP 200,
   ligne `retention_runs` cohérente avec la réponse JSON, `saturated=false`.
4. **Staging — cron** (autorisation distincte) : activer
   `postync-youtube-retention`. Durée d'observation dimensionnée par ce
   qu'elle vérifie, pas par un délai rituel — la passe étant quotidienne :
   * passe n° 1 déclenchée par pg_cron : prouve la chaîne
     pg_cron → pg_net → route → journal, jamais éprouvée ailleurs ;
   * passe n° 2, le lendemain : vérifie le comportement jour-après-jour SUR
     CES COMPTES-LÀ — `examined` stable, `refreshed ≈ 0` (identités relues la
     veille), zéro purge inattendue. C'est un contrôle de non-régression en
     réel, pas une preuve d'idempotence générale : celle-ci reste établie par
     les tests automatisés (§2), qu'aucun nombre de passes observées ne
     remplacerait.
   Deux passes consécutives propres suffisent donc pour ce que l'observation
   peut prouver ; au-delà, c'est la consultation de surveillance (§3, avec son
   responsable et son rythme) qui prend le relais, pas l'attente.
5. **Production — migrations, AVANT fusion** (autorisation) :
   `20260903090000`, `20260903150000`, `20260904090000`. Vérifier ensuite :
   colonnes présentes, `retention_runs` vide, `cron.job` porte le job
   INACTIF, aucun comportement nouveau (le code en production ignore tout de
   ces objets).
6. **Fusion de la PR #9** (autorisation), puis **contrôle du déploiement**
   Production : build Ready, SHA fusionné effectivement servi par
   `app.postync.app` (mêmes recoupements qu'au §1.1 : `dpl_` embarqué,
   source), route `/api/cron/retention` → 401 sans secret, `retention_runs`
   toujours vide, job toujours inactif.
7. **Production — activation du cron** (autorisation séparée) :
   `cron.alter_job(..., active := true)`. Première passe chargée PAR
   CONSTRUCTION : tous les comptes YouTube plus vieux que 7 jours sont relus
   (un échange + un `channels.list` chacun — quota Google à surveiller).
   Contrôle à J+1 (première passe : compteurs, échecs par compte), puis les
   requêtes du §3 comme geste court quotidien la première semaine,
   hebdomadaire ensuite.
   **Retour arrière** : tout signal anormal (purges inattendues, saturation,
   `error_code`, passe manquante) ⇒ DÉSACTIVER LE JOB D'ABORD (une commande,
   sans déploiement), analyser ensuite ; le code se retire par Instant
   Rollback Vercel. Les purges sont irréversibles — c'est la raison de
   l'ordre « couper puis comprendre ».

Interdits reconduits jusqu'à autorisation : aucune migration distante, aucune
fusion, aucune activation de cron.
