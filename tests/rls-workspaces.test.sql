-- ===========================================================================
-- POSTYNC — C4 : tests multi-tenant de `workspaces` / `workspace_members`
-- ===========================================================================
-- Vérifie AU NIVEAU DE LA BASE l'isolation entre workspaces, l'impossibilité
-- d'escalade de rôle, l'atomicité de `create_workspace()` et la stratégie de
-- slug.
--
-- MODE D'EMPLOI
--   Exécuter tel quel dans le SQL Editor Supabase (ou via
--   `npx supabase db query --linked -f tests/rls-workspaces.test.sql`).
--
-- Le script crée ses propres utilisateurs de test dans auth.users et est
-- encadré par BEGIN/ROLLBACK : il ne laisse AUCUNE trace. Il échoue
-- bruyamment (raise exception) au premier test non conforme.
-- ===========================================================================

begin;

do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  user_c uuid := gen_random_uuid();   -- admin du workspace A
  user_d uuid := gen_random_uuid();   -- member du workspace A

  ws_a  public.workspaces;
  ws_b  public.workspaces;
  ws_k1 public.workspaces;
  ws_k2 public.workspaces;
  ws_k3 public.workspaces;

  n          integer;
  txt        text;
  ws_count   integer;
  mbr_count  integer;

begin
  -- -------------------------------------------------------------------------
  -- Jeu de données : 4 comptes de test (annulés par le ROLLBACK final)
  -- -------------------------------------------------------------------------
  insert into auth.users
    (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
     raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
     confirmation_token, recovery_token, email_change_token_new, email_change)
  values
    (user_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'postync-c4-sql-a@example.test', '', now(), '{"provider":"email","providers":["email"]}',
     '{"display_name":"C4 SQL A"}', now(), now(), '', '', '', ''),
    (user_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'postync-c4-sql-b@example.test', '', now(), '{"provider":"email","providers":["email"]}',
     '{"display_name":"C4 SQL B"}', now(), now(), '', '', '', ''),
    (user_c, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'postync-c4-sql-c@example.test', '', now(), '{"provider":"email","providers":["email"]}',
     '{"display_name":"C4 SQL C"}', now(), now(), '', '', '', ''),
    (user_d, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'postync-c4-sql-d@example.test', '', now(), '{"provider":"email","providers":["email"]}',
     '{"display_name":"C4 SQL D"}', now(), now(), '', '', '', '');

  -- -------------------------------------------------------------------------
  -- Impersonation : exactement ce que fait PostgREST avec un JWT `authenticated`
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- =========================================================================
  -- ATOMICITÉ — create_workspace() = 1 workspace + 1 membership owner
  -- =========================================================================
  select * into ws_a from public.create_workspace('Workspace A');

  if ws_a.owner_id <> user_a then
    raise exception 'ATOMICITÉ ÉCHEC : owner_id (%) <> auth.uid() (%)', ws_a.owner_id, user_a;
  end if;

  select count(*) into mbr_count
  from public.workspace_members
  where workspace_id = ws_a.id and user_id = user_a and role = 'owner';
  if mbr_count <> 1 then
    raise exception 'ATOMICITÉ ÉCHEC : % membership(s) owner au lieu de 1', mbr_count;
  end if;
  raise notice 'ATOMICITÉ OK — workspace "%" (slug %) + owner membership', ws_a.name, ws_a.slug;

  -- Un nom invalide ne doit rien créer du tout.
  begin
    perform public.create_workspace('   ');
    raise exception 'ATOMICITÉ ÉCHEC : nom vide accepté';
  exception
    when invalid_parameter_value then
      raise notice 'ATOMICITÉ OK — nom vide refusé (%)', sqlerrm;
  end;

  -- =========================================================================
  -- SLUG — Kodeho, Kodeho, Kodeho -> kodeho, kodeho-2, kodeho-3
  -- =========================================================================
  select * into ws_k1 from public.create_workspace('Kodeho');
  select * into ws_k2 from public.create_workspace('Kodeho');
  select * into ws_k3 from public.create_workspace('Kodeho');

  if ws_k1.slug <> 'kodeho' or ws_k2.slug <> 'kodeho-2' or ws_k3.slug <> 'kodeho-3' then
    raise exception 'SLUG ÉCHEC : % / % / %', ws_k1.slug, ws_k2.slug, ws_k3.slug;
  end if;
  raise notice 'SLUG OK — % / % / %', ws_k1.slug, ws_k2.slug, ws_k3.slug;

  -- Normalisation : accents, espaces, ponctuation.
  select slug into txt from public.create_workspace('  Mon Agence — Éphémère & Co !  ');
  if txt <> 'mon-agence-ephemere-co' then
    raise exception 'SLUG ÉCHEC normalisation : %', txt;
  end if;
  raise notice 'SLUG OK — normalisation "%"', txt;

  -- Repli quand aucun caractère exploitable ne subsiste.
  select slug into txt from public.create_workspace('!!!');
  if txt <> 'workspace' then
    raise exception 'SLUG ÉCHEC repli : %', txt;
  end if;
  raise notice 'SLUG OK — repli "%"', txt;

  -- PLUSIEURS WORKSPACES — A en possède désormais 6.
  select count(*) into ws_count from public.workspaces;
  if ws_count <> 6 then
    raise exception 'MULTI ÉCHEC : A voit % workspace(s) au lieu de 6', ws_count;
  end if;
  raise notice 'MULTI OK — A voit ses % workspaces', ws_count;

  -- =========================================================================
  -- Workspace B (créé par B)
  -- =========================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_b::text, 'role', 'authenticated')::text, true);
  select * into ws_b from public.create_workspace('Workspace B');

  -- Retour sur A
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  -- =========================================================================
  -- T1 — A lit Workspace A
  -- =========================================================================
  select count(*) into n from public.workspaces where id = ws_a.id;
  if n <> 1 then raise exception 'T1 ÉCHEC : A ne lit pas Workspace A'; end if;
  raise notice 'T1 OK — A lit Workspace A';

  -- T2 — A ne lit PAS Workspace B
  select count(*) into n from public.workspaces where id = ws_b.id;
  if n <> 0 then raise exception 'T2 ÉCHEC : A lit Workspace B'; end if;
  select count(*) into n from public.workspaces where slug = ws_b.slug;
  if n <> 0 then raise exception 'T2 ÉCHEC : A lit Workspace B via son slug'; end if;
  raise notice 'T2 OK — Workspace B invisible pour A';

  -- T4 — A ne modifie PAS Workspace B (0 ligne touchée, silencieusement)
  update public.workspaces set name = 'Piraté' where id = ws_b.id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T4 ÉCHEC : A a modifié Workspace B'; end if;
  raise notice 'T4 OK — A ne modifie pas Workspace B';

  -- T5 — A ne peut PAS s'ajouter dans Workspace B
  begin
    insert into public.workspace_members (workspace_id, user_id, role)
    values (ws_b.id, user_a, 'member');
    raise exception 'T5 ÉCHEC : A s''est ajouté dans Workspace B';
  exception
    when insufficient_privilege then
      raise notice 'T5 OK — insertion refusée (%)', sqlerrm;
  end;

  -- T6 — A ne devient PAS admin arbitrairement (sur son propre membership)
  begin
    update public.workspace_members set role = 'admin'
    where workspace_id = ws_a.id and user_id = user_a;
    raise exception 'T6 ÉCHEC : A a modifié son rôle';
  exception
    when insufficient_privilege then
      raise notice 'T6 OK — PATCH role refusé (%)', sqlerrm;
  end;

  -- T7 — A ne devient PAS owner arbitrairement (ni de B, ni par owner_id)
  begin
    update public.workspace_members set role = 'owner'
    where workspace_id = ws_b.id and user_id = user_a;
    raise exception 'T7 ÉCHEC : A a écrit un rôle owner';
  exception
    when insufficient_privilege then
      raise notice 'T7 OK — écriture du rôle owner refusée';
  end;
  begin
    update public.workspaces set owner_id = user_a where id = ws_a.id;
    raise exception 'T7 ÉCHEC : A a écrit owner_id';
  exception
    when insufficient_privilege then
      raise notice 'T7 OK — écriture de owner_id refusée (%)', sqlerrm;
  end;

  -- T8 — Un owner lit ses memberships
  select count(*) into n from public.workspace_members where user_id = user_a;
  if n <> 6 then raise exception 'T8 ÉCHEC : A voit % membership(s) au lieu de 6', n; end if;
  raise notice 'T8 OK — A lit ses % memberships', n;

  -- A ne voit PAS les memberships de Workspace B
  select count(*) into n from public.workspace_members where workspace_id = ws_b.id;
  if n <> 0 then raise exception 'T8 ÉCHEC : A voit les memberships de B'; end if;

  -- =========================================================================
  -- T3 — B ne lit pas Workspace A ; T10 — non-membre refusé
  -- =========================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_b::text, 'role', 'authenticated')::text, true);

  select count(*) into n from public.workspaces where id = ws_a.id;
  if n <> 0 then raise exception 'T3 ÉCHEC : B lit Workspace A'; end if;
  raise notice 'T3 OK — Workspace A invisible pour B';

  select count(*) into n from public.workspaces;
  if n <> 1 then raise exception 'T10 ÉCHEC : B voit % workspace(s) au lieu de 1', n; end if;
  select count(*) into n from public.workspace_members;
  if n <> 1 then raise exception 'T10 ÉCHEC : B voit % membership(s) au lieu de 1', n; end if;
  if public.is_workspace_member(ws_a.id) then
    raise exception 'T10 ÉCHEC : is_workspace_member(A) vrai pour B';
  end if;
  raise notice 'T10 OK — non-membre : aucun accès au workspace A';

  -- =========================================================================
  -- RÔLES — ajout d'un admin (C) et d'un member (D) dans Workspace A
  -- (insertion côté serveur : aucune RPC de gestion de membres en C4)
  -- =========================================================================
  execute 'reset role';
  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws_a.id, user_c, 'admin'), (ws_a.id, user_d, 'member');

  -- Cohérence owner : impossible de créer un second owner, de rétrograder
  -- ou de retirer le owner, même côté serveur.
  begin
    insert into public.workspace_members (workspace_id, user_id, role)
    values (ws_b.id, user_c, 'owner');
    raise exception 'OWNER ÉCHEC : second owner accepté';
  exception
    when check_violation or unique_violation then
      raise notice 'OWNER OK — second owner refusé';
  end;
  begin
    update public.workspace_members set role = 'member'
    where workspace_id = ws_a.id and user_id = user_a;
    raise exception 'OWNER ÉCHEC : owner rétrogradé';
  exception
    when check_violation then
      raise notice 'OWNER OK — rétrogradation du owner refusée';
  end;
  begin
    delete from public.workspace_members
    where workspace_id = ws_a.id and user_id = user_a;
    raise exception 'OWNER ÉCHEC : membership owner supprimée';
  exception
    when check_violation then
      raise notice 'OWNER OK — suppression de la membership owner refusée';
  end;
  begin
    update public.workspaces set owner_id = user_c where id = ws_a.id;
    raise exception 'OWNER ÉCHEC : owner_id modifié sans transfert';
  exception
    when check_violation then
      raise notice 'OWNER OK — changement de owner_id refusé';
  end;

  execute 'set local role authenticated';

  -- T9 — un member (D) accède au workspace A
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_d::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.workspaces where id = ws_a.id;
  if n <> 1 then raise exception 'T9 ÉCHEC : member D ne lit pas Workspace A'; end if;
  if public.workspace_role(ws_a.id) <> 'member' then
    raise exception 'T9 ÉCHEC : rôle de D = %', public.workspace_role(ws_a.id);
  end if;
  raise notice 'T9 OK — member D accède au workspace A';

  -- member : ne modifie pas le workspace
  update public.workspaces set name = 'Renommé par member' where id = ws_a.id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'RÔLES ÉCHEC : member a modifié le workspace'; end if;
  raise notice 'RÔLES OK — member ne modifie pas le workspace';

  -- member : ne se promeut pas
  begin
    update public.workspace_members set role = 'admin'
    where workspace_id = ws_a.id and user_id = user_d;
    raise exception 'RÔLES ÉCHEC : member -> admin';
  exception
    when insufficient_privilege then
      raise notice 'RÔLES OK — member -> admin refusé';
  end;

  -- admin (C) : modifie le nom, mais ne se promeut pas owner
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_c::text, 'role', 'authenticated')::text, true);
  update public.workspaces set name = 'Workspace A (renommé par admin)' where id = ws_a.id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RÔLES ÉCHEC : admin ne peut pas renommer'; end if;
  raise notice 'RÔLES OK — admin renomme le workspace';

  begin
    update public.workspace_members set role = 'owner'
    where workspace_id = ws_a.id and user_id = user_c;
    raise exception 'RÔLES ÉCHEC : admin -> owner';
  exception
    when insufficient_privilege then
      raise notice 'RÔLES OK — admin -> owner refusé';
  end;

  -- owner (A) : modifie le nom
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);
  update public.workspaces set name = 'Workspace A' where id = ws_a.id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RÔLES ÉCHEC : owner ne peut pas renommer'; end if;
  raise notice 'RÔLES OK — owner renomme le workspace';

  -- =========================================================================
  -- Invariant global : aucun workspace sans owner, aucune membership orpheline
  -- =========================================================================
  execute 'reset role';
  select count(*) into n from public.workspaces w
  where not exists (select 1 from public.workspace_members m
                    where m.workspace_id = w.id and m.user_id = w.owner_id and m.role = 'owner');
  if n <> 0 then raise exception 'INVARIANT ÉCHEC : % workspace(s) sans owner', n; end if;
  raise notice 'INVARIANT OK — chaque workspace possède exactement son owner';

  -- Suppression d'un workspace : la cascade retire ses memberships, owner compris
  delete from public.workspaces where id = ws_k3.id;
  select count(*) into n from public.workspace_members where workspace_id = ws_k3.id;
  if n <> 0 then raise exception 'CASCADE ÉCHEC : memberships restantes'; end if;
  raise notice 'CASCADE OK — suppression du workspace nettoie ses memberships';

  -- Suppression d'un owner : refusée tant qu'il possède un workspace
  begin
    delete from auth.users where id = user_b;
    raise exception 'RESTRICT ÉCHEC : owner supprimé avec son workspace encore présent';
  exception
    when foreign_key_violation then
      raise notice 'RESTRICT OK — suppression d''un owner refusée tant qu''il possède un workspace';
  end;

  raise notice '--- TOUS LES TESTS C4 SONT PASSÉS ---';
end
$$;

rollback;
