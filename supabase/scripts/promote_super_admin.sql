-- ===========================================================================
-- POSTYNC — Promotion manuelle du PREMIER super_admin (opération C6)
-- ===========================================================================
-- À exécuter UNE FOIS, côté base, avec des droits privilégiés :
--   * SQL Editor Supabase (rôle postgres), ou
--   * npx supabase db query --linked --project-ref <ref> -f supabase/scripts/promote_super_admin.sql
--
-- Aucun bouton, aucune RPC ne permet à un utilisateur de se promouvoir : la
-- seule voie est cette opération contrôlée. Les promotions suivantes passent
-- par /admin (RPC admin_set_platform_role, réservée aux super_admin et
-- journalisée dans admin_audit_logs).
--
-- 1. Remplacer l'adresse ci-dessous par celle du compte (déjà inscrit et
--    confirmé) qui doit devenir super_admin.
-- 2. Exécuter. Le script échoue si le compte n'existe pas ou n'a pas de
--    profil, et journalise l'opération (acteur = le compte lui-même, source
--    "manual_bootstrap").
-- ===========================================================================

do $$
declare
  v_email text := 'ADRESSE@A-REMPLACER.example';   -- >>> À REMPLACER <<<
  v_user  uuid;
  v_role  text;
begin
  select u.id into v_user from auth.users u where lower(u.email) = lower(v_email);
  if v_user is null then
    raise exception 'Aucun compte pour %', v_email;
  end if;

  select p.platform_role into v_role from public.profiles p where p.id = v_user;
  if v_role is null then
    raise exception 'Aucun profil pour % (trigger on_auth_user_created ?)', v_email;
  end if;

  if v_role = 'super_admin' then
    raise notice '% est déjà super_admin', v_email;
    return;
  end if;

  update public.profiles
  set platform_role = 'super_admin', account_status = 'active'
  where id = v_user;

  insert into public.admin_audit_logs (actor_user_id, action, target_type, target_id, metadata)
  values (v_user, 'user.role_changed', 'user', v_user::text,
          jsonb_build_object('from', v_role, 'to', 'super_admin', 'source', 'manual_bootstrap'));

  raise notice '% promu super_admin', v_email;
end
$$;
