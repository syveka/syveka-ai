-- Recovery drill §6, first statements of the restore transaction (s6).
--
-- Clear the destination's schema-level default privileges for the restoring
-- role in public. pg_dump writes each object's grants relative to the
-- built-in defaults, so any grant the destination's own defaults add when a
-- table is created (hosted Supabase grants anon/authenticated/service_role)
-- would survive the restore and widen access. The archive's own
-- "DEFAULT ACL public ... postgres" entries, restored at the end of the same
-- transaction, then reinstate production's defaults. privileges.sql verifies
-- the result object by object.
do $clear_public_defaults$
declare
  entry record;
begin
  for entry in
    select distinct
      case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences'
        when 'f' then 'functions' when 'T' then 'types' end as object_type,
      case when a.grantee = 0 then 'public' else quote_ident(a.grantee::regrole::text) end as grantee
    from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
    where d.defaclrole = current_user::regrole
      and d.defaclnamespace = 'public'::regnamespace
      and d.defaclobjtype in ('r', 'S', 'f', 'T')
      and a.grantee <> current_user::regrole
  loop
    execute format('alter default privileges for role %I in schema public revoke all on %s from %s',
      current_user, entry.object_type, entry.grantee);
  end loop;
end
$clear_public_defaults$;
