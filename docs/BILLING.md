# Billing

Facturation Stripe de POSTYNC (C7).

## Principes

- **Stripe est la source de vérité du paiement.** POSTYNC reste la source de
  vérité de l'identité, des workspaces, des memberships, des `platform_role`
  et des entitlements Kodeho. Un abonnement ne contourne jamais la sécurité
  multi-tenant.
- **L'abonnement est rattaché au workspace**, pas au profil : un utilisateur
  peut posséder plusieurs workspaces avec des niveaux commerciaux différents.
- La base locale (`billing_customers`, `subscriptions`) est une **réplique**
  synchronisée exclusivement par le webhook signé. La page de succès du
  checkout n'active jamais rien.

## Plans et prix

Référence commerciale : `src/config/plans.ts` (Free 0 €, Creator 12,90 €/mois,
Pro 29,90 €/mois, Agency 79,90 €/mois ; annuel = 2 mois offerts : 129 €,
299 €, 799 €). Les montants réellement facturés sont pilotés par les
**Price IDs Stripe**, configurés par variables d'environnement :

```text
STRIPE_PRICE_CREATOR_MONTHLY   STRIPE_PRICE_CREATOR_YEARLY
STRIPE_PRICE_PRO_MONTHLY       STRIPE_PRICE_PRO_YEARLY
STRIPE_PRICE_AGENCY_MONTHLY    STRIPE_PRICE_AGENCY_YEARLY
```

Le plan Free n'a pas de Price Stripe. `src/server/stripe/config.ts` est la
seule table de correspondance (plan, intervalle) → Price ID et Price ID →
plan : **aucun Price ID venant du navigateur n'est jamais utilisé**.

## Checkout

`startCheckoutAction` (`src/server/stripe/actions.ts`) :

1. session revalidée + compte actif (`requireUser`) ;
2. workspace résolu par slug contre les memberships réelles sous RLS ;
3. seul un `owner` ou `admin` du workspace peut gérer la facturation
   (un `member` est refusé) ;
4. le navigateur soumet uniquement `(plan, interval)` ; le Price ID est résolu
   côté serveur ;
5. customer Stripe : réutilisé s'il existe dans `billing_customers`, créé
   sinon (metadata `workspace_id`) — upsert sur `workspace_id` contre les
   doublons ;
6. `success_url` / `cancel_url` construites par le serveur depuis
   `NEXT_PUBLIC_SITE_URL` (ou l'origine de la requête) — aucune URL du client ;
7. metadata Stripe : `workspace_id`, `plan_key` uniquement (jamais de jeton,
   secret ou mot de passe).

Pages de retour : `/app/[workspaceSlug]/billing/success` (« Paiement reçu.
Synchronisation… », n'active rien) et `.../billing/cancel`.

## Webhook — `/api/stripe/webhook`

- Raw body + signature `stripe-signature` vérifiée avec
  `STRIPE_WEBHOOK_SECRET` (400 sinon).
- **Idempotence** : `subscription_events.stripe_event_id` unique ; un
  événement rejoué renvoie `duplicate` sans être réappliqué. En cas d'échec de
  traitement, le verrou est retiré et un 500 laisse Stripe rejouer.
- Événements traités : `checkout.session.completed` (mapping customer),
  `customer.subscription.created|updated|deleted` (synchronisation complète),
  `invoice.paid` (retour à `active` si la réplique était en retard),
  `invoice.payment_failed` (passage en `past_due`).
- `payload_metadata` : identifiants et statuts seulement, jamais le payload
  complet.
- Écritures via le client service_role (`src/server/supabase/service-client.ts`,
  `server-only`) — la signature Stripe fait office d'authentification, il n'y
  a pas de session utilisateur.

## Billing Portal

`openBillingPortalAction` : mêmes contrôles que le checkout, puis session de
portail Stripe (factures, moyen de paiement, annulation) avec `return_url`
construit par le serveur.

## Résolution d'accès — `resolveWorkspaceAccess()`

`src/server/billing/access.ts` :

```text
1. Full Access Kodeho valide   -> accès maximal (quotas Agency), sans Stripe
2. abonnement active/trialing/past_due (plan connu) -> plan de l'abonnement
3. sinon                        -> Free
```

- Full Access expiré → retombe sur l'abonnement actif, sinon Free (testé
  F1–F4).
- Les modules futurs consomment `getWorkspaceAccess()` → quotas du plan
  (`src/config/plans.ts`).

### Statuts

| Statut Stripe        | Accès au plan payé | Compté dans MRR/actifs |
| -------------------- | ------------------ | ---------------------- |
| `active`, `trialing` | oui                | oui                    |
| `past_due`           | **oui, avec avertissement** | non           |
| `canceled`, `unpaid`, `incomplete`, `incomplete_expired`, `paused` | non | non |

**Politique `past_due` (V1)** : au premier échec bancaire, l'accès payé est
conservé temporairement et la page billing affiche un avertissement — on ne
bloque pas brutalement un client. Stripe relance les paiements ; si
l'abonnement finit `canceled`/`unpaid`, le workspace retombe sur Free.

**Annulation** : `cancel_at_period_end = true` → l'accès payé continue jusqu'à
`current_period_end` (le statut Stripe reste `active`), puis Free — sauf Full
Access.

**Downgrade** (ex. Pro → Creator) : POSTYNC ne supprime jamais de données.
`quotaOverages()` détecte les dépassements : les nouvelles créations sont
bloquées (`canCreate`) et une alerte est affichée. (Application effective des
compteurs : C8.)

## MRR (règle documentée)

`computeMrrCents()` : abonnements `active` + `trialing` uniquement ; mensuel =
prix mensuel du plan ; annuel = prix annuel / 12 arrondi au centime inférieur ;
prix de **référence** (`src/config/plans.ts`), pas les montants réellement
facturés par Stripe ; plans non mappés ignorés du MRR (mais comptés dans les
« abonnements actifs »).

## Administration

- `/admin/subscriptions` : abonnements réels (workspace, client, plan, statut,
  périodicité, renouvellement, Full Access) + MRR et actifs.
- `/admin/plans` : mensuel + annuel + état de configuration des 6 Price IDs
  (présence des variables — jamais leur valeur).
- `/admin/platform` : Stripe « Configuré » si `STRIPE_SECRET_KEY` **et**
  `STRIPE_WEBHOOK_SECRET` existent.
- Les webhooks Stripe sont tracés dans `subscription_events`, pas dans
  `admin_audit_logs` (réservé aux actions humaines Kodeho).

## Environnements

C7 fonctionne en **Stripe Test Mode** (clés `sk_test_…`, cartes de test
Stripe). Aucun numéro de carte ne transite ni n'est stocké par POSTYNC :
Checkout héberge la saisie.

### Variables (`.env.local`, puis Vercel)

| Variable | Où la trouver |
| --- | --- |
| `STRIPE_SECRET_KEY` | Dashboard Stripe → Developers → API keys (mode Test) |
| `STRIPE_WEBHOOK_SECRET` | Developers → Webhooks → endpoint → Signing secret (ou `stripe listen`) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Developers → API keys |
| `STRIPE_PRICE_*` (6) | Product catalog → produit → prix → « Price ID » (`price_…`) |

### Webhook local

`stripe listen --forward-to localhost:3000/api/stripe/webhook` fournit un
`whsec_…` temporaire à mettre dans `STRIPE_WEBHOOK_SECRET`. `stripe trigger`
permet de rejouer des événements.

### Vercel et Deployment Protection

Stripe ne peut pas envoyer d'en-têtes personnalisés : si **Vercel
Authentication / Deployment Protection** couvre la production, les webhooks
sont bloqués (401). Solutions, de la plus simple à la plus fine :

1. limiter la protection aux **previews** et laisser la production publique
   (les routes applicatives restent protégées par Supabase Auth + RLS) ;
2. sinon, activer **Protection Bypass for Automation** et ajouter le secret en
   *query param* à l'URL du webhook côté Stripe :
   `https://<domaine>/api/stripe/webhook?x-vercel-protection-bypass=<secret>`
   (Vercel accepte ce paramètre en query string, ce qui est compatible avec
   Stripe).

Le choix retenu doit être vérifié en envoyant un événement de test depuis le
Dashboard Stripe et en contrôlant la réponse 200. La sécurité du webhook
lui-même repose sur la signature, pas sur la protection Vercel.

## Tests

- `tests/billing-access.test.ts` : F1–F4, statuts, past_due, downgrade, MRR,
  mapping Price IDs (C4 inclus).
- `tests/integration/stripe-webhook.test.ts` : S1–S7 contre la vraie route et
  la vraie base — signatures HMAC réelles générées localement
  (`Stripe.webhooks.generateTestHeaderString`), idempotence, RLS.
- `tests/integration/stripe-checkout.test.ts` : C1–C5 avec de vrais JWT
  (member refusé, owner/admin autorisés, Price ID arbitraire impossible,
  isolation inter-workspaces), portail inclus.
- Le parcours E2E complet (checkout réel → carte de test → webhook →
  billing/portail) exige les clés Stripe Test : voir la checklist en fin de
  document.
