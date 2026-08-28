-- Journal des envois de courriels, et surtout garde-fou d'idempotence.
--
-- POURQUOI UNE TABLE PLUTOT QU'UN SIMPLE APPEL. Un envoi n'est pas
-- rejouable : deux fois le meme courriel de reinitialisation ou deux fois la
-- meme invitation, c'est au mieux de la confusion, au pire deux liens vivants
-- la ou un seul devait l'etre. Or les Server Actions PEUVENT etre rejouees —
-- double clic, reprise reseau, nouvelle tentative du navigateur.
--
-- LA CLE D'IDEMPOTENCE EST UNIQUE, et c'est elle qui porte la garantie. On
-- INSERE AVANT d'envoyer : si l'insertion echoue en 23505, un envoi pour cette
-- meme cause a deja eu lieu (ou est en cours), et l'on ne renvoie rien.
-- Verifier puis inserer laisserait la fenetre habituelle entre les deux.
--
-- CE QUI N'EST PAS STOCKE ICI. Ni le corps du message, ni aucun lien : une
-- invitation porte un jeton, et le conserver dans une table de journal
-- reviendrait a annuler le soin pris a ne stocker que son empreinte.
create table if not exists public.email_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  idempotency_key     text not null,
  template            text not null,
  recipient           text not null,
  workspace_id        uuid references public.workspaces(id) on delete set null,
  status              text not null default 'sending',
  provider_message_id text,
  failure_code        text,
  attempts            integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint email_deliveries_status_check
    check (status in ('sending', 'sent', 'failed')),

  constraint email_deliveries_recipient_normalized
    check (recipient = lower(btrim(recipient)) and recipient like '%_@_%.%')
);

-- LA garantie. Sans cet index, tout le reste n'est que discipline.
create unique index if not exists email_deliveries_key_idx
  on public.email_deliveries (idempotency_key);

create index if not exists email_deliveries_created_idx
  on public.email_deliveries (created_at desc);

drop trigger if exists email_deliveries_set_updated_at on public.email_deliveries;
create trigger email_deliveries_set_updated_at
  before update on public.email_deliveries
  for each row execute function public.set_updated_at();

alter table public.email_deliveries enable row level security;

-- AUCUN acces pour les sessions : ni grant, ni politique, comme `oauth_states`
-- et `social_connection_drafts`. Ce journal est purement serveur ; le rendre
-- lisible reviendrait a exposer qui recoit quoi, et quand.
revoke all on public.email_deliveries from anon, authenticated;

comment on table public.email_deliveries is
  'Journal des envois et garde-fou d''idempotence. Aucun contenu de message ni lien n''y est stocke. Serveur uniquement.';
comment on column public.email_deliveries.idempotency_key is
  'Cause de l''envoi, stable et unique — p. ex. « invitation:<id> ». Insere AVANT l''envoi.';
