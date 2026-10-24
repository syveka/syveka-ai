-- Recovery drill: per-table row counts for the tables a drill restore carries
-- (every public table, plus auth.users, auth.identities, storage.buckets and
-- storage.objects). Counts only. Output: `rows|<schema>.<table>|<count>`.
-- s5 records it for the sanitized database; s6 requires the destination to
-- match it exactly.
with carried as (
  select n.nspname as schema_name, c.relname as table_name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and (n.nspname = 'public'
      or (n.nspname = 'auth' and c.relname in ('users', 'identities'))
      or (n.nspname = 'storage' and c.relname in ('buckets', 'objects')))
)
select 'rows', schema_name || '.' || table_name,
  (xpath('/row/n/text()', query_to_xml(
    format('select count(*) as n from %I.%I', schema_name, table_name), false, true, '')))[1]::text
from carried
order by 2;
