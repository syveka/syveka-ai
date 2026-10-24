-- Recovery drill: privilege fingerprint of the public schema. Names and
-- privilege types only. Output: `acl|<kind>|<object>|<grantee>|<privileges>`
-- for every grant to a role other than the object's owner (so ownership
-- normalization by s6 --no-owner does not change it), plus postgres's own
-- default privileges in public (kind default:*). s5 records it for the
-- sanitized database; s6 requires the destination to match it exactly.
with objects as (
  select case c.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'matview' else 'table' end as kind,
         c.relname::text as object_name, c.relowner as owner_oid,
         coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner)) as acl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  union all
  select 'function', p.oid::regprocedure::text, p.proowner,
         coalesce(p.proacl, acldefault('f'::"char", p.proowner))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
),
grants as (
  select o.kind, o.object_name, a.grantee, a.privilege_type
  from objects o cross join lateral aclexplode(o.acl) a
  where a.grantee <> o.owner_oid
),
-- The restoring role's own schema-level default privileges in public (what
-- later CREATEs by postgres will grant). Other roles' defaults belong to the
-- platform and are not restored (README.md, "Grants and ACL limits").
default_grants as (
  select case d.defaclobjtype when 'r' then 'default:tables' when 'S' then 'default:sequences'
           when 'f' then 'default:functions' when 'T' then 'default:types' else 'default:' || d.defaclobjtype::text end as kind,
         'postgres in public'::text as object_name, a.grantee, a.privilege_type
  from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
  where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
    and a.grantee <> 'postgres'::regrole
),
all_grants as (select * from grants union all select * from default_grants)
select 'acl', kind, object_name,
       case when grantee = 0 then 'PUBLIC' else grantee::regrole::text end,
       string_agg(privilege_type, ',' order by privilege_type)
from all_grants
group by kind, object_name, grantee
order by 2, 3, 4;
