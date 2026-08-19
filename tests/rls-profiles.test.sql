-- ===========================================================================
-- POSTYNC — Test RLS de la table `profiles`
-- ===========================================================================
-- Vérifie AU NIVEAU DE LA BASE (et non de l'interface) qu'un utilisateur A
-- ne peut ni lire ni modifier le profil d'un utilisateur B, et qu'il ne peut
-- pas s'octroyer un `platform_role` privilégié.
--
-- MODE D'EMPLOI
--   1. Créer deux comptes de test via /signup (ou le tableau de bord Supabase).
--   2. Relever leurs UUID :  select id, email from auth.users order by created_at;
--   3. Renseigner user_a et user_b ci-dessous.
--   4. Exécuter ce script dans le SQL Editor Supabase.
--
-- Le script est encadré par BEGIN/ROLLBACK : il ne laisse aucune trace.
-- Il échoue bruyamment (raise exception) au premier test non conforme.
-- ===========================================================================

begin;

do $$
declare
  -- >>> À REMPLACER PAR LES UUID RÉELS <<<
  user_a uuid := '00000000-0000-0000-0000-000000000001';
  user_b uuid := '00000000-0000-0000-0000-000000000002';

  n        integer;
  role_now text;
begin
  if user_a = user_b then
    raise exception 'user_a et user_b doivent être deux comptes différents';
  end if;

  -- Se faire passer pour l'utilisateur A, exactement comme PostgREST le fait.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';

  -- -------------------------------------------------------------------------
  -- T1 — A lit son propre profil
  -- -------------------------------------------------------------------------
  select count(*) into n from public.profiles where id = user_a;
  if n <> 1 then
    raise exception 'T1 ÉCHEC : A ne voit pas son propre profil (% ligne(s))', n;
  end if;
  raise notice 'T1 OK — A lit son propre profil';

  -- -------------------------------------------------------------------------
  -- T2 — A ne voit PAS le profil de B
  -- -------------------------------------------------------------------------
  select count(*) into n from public.profiles where id = user_b;
  if n <> 0 then
    raise exception 'T2 ÉCHEC : A voit le profil de B (% ligne(s))', n;
  end if;
  raise notice 'T2 OK — le profil de B est invisible pour A';

  -- -------------------------------------------------------------------------
  -- T3 — A ne peut PAS modifier le profil de B
  -- -------------------------------------------------------------------------
  update public.profiles set display_name = 'compromis' where id = user_b;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'T3 ÉCHEC : A a modifié % ligne(s) du profil de B', n;
  end if;
  raise notice 'T3 OK — A ne modifie pas le profil de B';

  -- -------------------------------------------------------------------------
  -- T4 — A ne peut PAS s'octroyer un platform_role privilégié
  --       (bloqué par les privilèges de colonne, pas par l'application)
  -- -------------------------------------------------------------------------
  begin
    update public.profiles set platform_role = 'super_admin' where id = user_a;
    raise exception 'T4 ÉCHEC CRITIQUE : escalade user -> super_admin possible';
  exception
    when insufficient_privilege then
      raise notice 'T4 OK — écriture de platform_role refusée par PostgreSQL';
  end;

  -- -------------------------------------------------------------------------
  -- T5 — A peut modifier ses propres champs autorisés
  -- -------------------------------------------------------------------------
  update public.profiles set display_name = 'Test RLS' where id = user_a;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'T5 ÉCHEC : A ne peut pas modifier son propre profil';
  end if;
  raise notice 'T5 OK — A modifie son propre display_name';

  -- -------------------------------------------------------------------------
  -- T6 — A ne peut PAS insérer un profil arbitraire
  -- -------------------------------------------------------------------------
  begin
    insert into public.profiles (id, display_name) values (gen_random_uuid(), 'injecté');
    raise exception 'T6 ÉCHEC : insertion arbitraire autorisée';
  exception
    when insufficient_privilege or check_violation or foreign_key_violation then
      raise notice 'T6 OK — insertion directe refusée';
  end;

  select current_user into role_now;
  raise notice '--- TOUS LES TESTS RLS SONT PASSÉS (rôle courant : %) ---', role_now;
end
$$;

rollback;
