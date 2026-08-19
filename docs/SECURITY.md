# Security

Principes de sécurité de POSTYNC.

Points à couvrir : gestion des secrets et des variables d'environnement,
stockage des jetons OAuth des plateformes sociales, séparation des rôles
(`PlatformRole`, `WorkspaceRole`), isolation des données par workspace.

Aucun secret ne doit être versionné. Seul `.env.example` est commité, sans
aucune valeur réelle.

Ce document sera complété au fur et à mesure des étapes suivantes.
