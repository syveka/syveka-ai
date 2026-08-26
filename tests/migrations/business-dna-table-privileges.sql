-- Regression coverage for the Business DNA ACL hardening migration.
-- This script is transactional and leaves no probe table behind.

do $$
declare
  checked_role text;
  checked_table text;
  checked_privilege text;
  checked_privileges text[] := array['TRUNCATE', 'REFERENCES', 'TRIGGER'];
begin
  if current_setting('server_version_num')::integer >= 170000 then
    checked_privileges := array_append(checked_privileges, 'MAINTAIN');
  end if;

  foreach checked_role in array array['anon', 'authenticated'] loop
    foreach checked_table in array array['business_dna', 'business_dna_services'] loop
      foreach checked_privilege in array checked_privileges loop
        if has_table_privilege(
          checked_role,
          format('public.%I', checked_table),
          checked_privilege
        ) then
          raise exception
            'BUSINESS DNA ACL FAIL: role % has % on public.%',
            checked_role, checked_privilege, checked_table;
        end if;
      end loop;
    end loop;
  end loop;
end $$;

begin;

create table public.business_dna_default_privilege_probe (
  id integer primary key
);

do $$
declare
  checked_role text;
  checked_privilege text;
  checked_privileges text[] := array['TRUNCATE', 'REFERENCES', 'TRIGGER'];
begin
  if current_setting('server_version_num')::integer >= 170000 then
    checked_privileges := array_append(checked_privileges, 'MAINTAIN');
  end if;

  if (select pg_get_userbyid(relowner)
      from pg_class
      where oid = 'public.business_dna_default_privilege_probe'::regclass) <> current_user then
    raise exception 'BUSINESS DNA ACL FAIL: default privilege probe is not owned by the migration role';
  end if;

  foreach checked_role in array array['anon', 'authenticated'] loop
    foreach checked_privilege in array checked_privileges loop
      if has_table_privilege(
        checked_role,
        'public.business_dna_default_privilege_probe',
        checked_privilege
      ) then
        raise exception
          'BUSINESS DNA DEFAULT ACL FAIL: role % inherited % on a new migration-owner table',
          checked_role, checked_privilege;
      end if;
    end loop;
  end loop;
end $$;

rollback;
