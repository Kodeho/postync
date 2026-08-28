-- C14 — une acceptation doit survivre a la disparition de son auteur.
--
-- ANOMALIE DEMONTREE le 2026-08-28, en nettoyant l'E2E : supprimer un compte
-- ayant accepte une invitation echouait avec « Database error deleting user ».
--
-- CAUSE. `accepted_by` est `on delete set null` — c'est le bon choix, la trace
-- de l'acceptation ne doit pas disparaitre avec le compte. Mais la contrainte
-- posee avec la table exigeait `accepted_at is null or accepted_by is not
-- null` : la mise a null entrait donc en collision avec elle, et la
-- suppression etait refusee. Deux regles correctes prises separement, et
-- incompatibles ensemble.
--
-- CONSEQUENCE, plus large que l'E2E : toute personne ayant un jour rejoint un
-- workspace par invitation devenait INSUPPRIMABLE, y compris pour un
-- administrateur de la plateforme.
--
-- L'invariant utile est l'autre sens : on ne designe pas un accepteur sans
-- acceptation. Une acceptation dont l'auteur a ete supprime reste, elle, un
-- fait parfaitement coherent — c'est meme la seule facon honnete de la
-- representer.
alter table public.workspace_invitations
  drop constraint if exists workspace_invitations_accepted_shape;

alter table public.workspace_invitations
  add constraint workspace_invitations_accepted_shape
  check (accepted_by is null or accepted_at is not null);

comment on column public.workspace_invitations.accepted_by is
  'Auteur de l''acceptation. Devient null si le compte est supprime : l''acceptation, elle, reste vraie.';
