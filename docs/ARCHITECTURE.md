# Architecture

Vue d'ensemble technique de POSTYNC.

POSTYNC est une application SaaS permettant d'importer une vidéo une seule fois
puis de la publier sur plusieurs réseaux sociaux (Instagram, Facebook, TikTok,
YouTube) depuis une interface centralisée.

Stack : Next.js (App Router), React, TypeScript, Tailwind CSS.

Organisation du code source (`src/`) :

- `app/` — routes App Router
- `components/` — composants partagés (`ui/`, `layout/`)
- `features/` — modules fonctionnels (auth, workspaces, accounts, billing,
  media, publishing, calendar, admin)
- `integrations/` — connecteurs des plateformes sociales (meta, tiktok, youtube)
- `server/` — logique côté serveur (auth, billing, jobs, publishing, security)
- `lib/` — utilitaires transverses
- `config/` — configuration produit
- `types/` — types partagés

Ce document sera complété au fur et à mesure des étapes suivantes.
