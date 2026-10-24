-- Recovery drill: session-local scrub and detection functions (pg_temp only;
-- nothing persistent is created). Loaded in the same psql session before
-- sanitize.sql (s5) and before sanitize-checks.sql (s5 and s6), so the
-- scrubber and the checks share one definition of "sensitive".
--
-- Scope: every json/jsonb and text-like column (text, varchar, char and their
-- arrays; generated columns excluded) of every table a drill restore carries:
-- all of public, plus auth.users, auth.identities, storage.buckets and
-- storage.objects.
--
-- JSON values are redacted when
--   * the key names a credential (drill_sensitive_key), and the value is a
--     non-empty string, an object or an array;
--   * the object is a workflow email step ({"type": "email.send", "to": ...}),
--     at any depth: the recipient is outbound configuration;
--   * a string carries a known secret format or a URL with embedded
--     credentials or a signature/token query parameter (drill_scrub_text).
-- Text columns get the same secret-format and URL treatment. Free text that
-- contains a credential in no recognizable format is NOT detectable; see
-- README.md, "Coverage limits".

create function pg_temp.drill_sensitive_key(key text) returns boolean
language sql immutable as $$
  select key ~* '(secret|token|passw|pwd|api_?key|apikey|authorization|auth_?header|bearer|cookie|credential|private_?key|signing_?key|access_?key|webhook_?url|callback_?url|dsn|connection_?string)'
$$;

-- Known secret formats, plus credential-bearing URL parts. Case-sensitive on
-- purpose (vendor prefixes are fixed-case); \m anchors each prefix at a word
-- start, so "task-..." is not read as "sk-...". The query-parameter rule is
-- case-insensitive. lib.sh SECRET_ERE is the same list for archive scans.
create function pg_temp.drill_secret_patterns() returns text[]
language sql immutable as $$
  select array[
    '\m(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}',
    '\mwhsec_[A-Za-z0-9]{8,}',
    '\msk-ant-[A-Za-z0-9_-]{8,}',
    '\msk-(proj-)?[A-Za-z0-9_-]{20,}',
    '\mxox[abprs]-[A-Za-z0-9-]{8,}',
    '\mgh[pousr]_[A-Za-z0-9]{20,}',
    '\mgithub_pat_[A-Za-z0-9_]{20,}',
    '\mAKIA[0-9A-Z]{16}',
    '\mAIza[0-9A-Za-z_-]{30,}',
    '\mya29\.[0-9A-Za-z_-]{10,}',
    '\mEAA[A-Za-z0-9]{20,}',
    '\mre_[A-Za-z0-9]{8,}_[A-Za-z0-9_]{8,}',
    '\meyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}',
    '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  ]
$$;

create function pg_temp.drill_has_secret_text(value text) returns boolean
language plpgsql immutable as $$
declare
  pattern text;
begin
  if value is null or value = '' then return false; end if;
  foreach pattern in array pg_temp.drill_secret_patterns() loop
    if value ~ pattern then return true; end if;
  end loop;
  return value ~ '(https?://)[^\s/@:"'']+:[^\s/@"'']+@'
      or value ~* '[?&](access_token|refresh_token|id_token|token|api_key|apikey|key|sig|signature|x-amz-signature|x-amz-credential|secret|code)=[^&\s"''\[]';
end
$$;

create function pg_temp.drill_scrub_text(value text) returns text
language plpgsql immutable as $$
declare
  pattern text;
  result text := value;
begin
  if result is null or result = '' then return result; end if;
  foreach pattern in array pg_temp.drill_secret_patterns() loop
    result := regexp_replace(result, pattern, '[redacted]', 'g');
  end loop;
  result := regexp_replace(result, '(https?://)[^\s/@:"'']+:[^\s/@"'']+@', '\1[redacted]@', 'g');
  result := regexp_replace(result,
    '([?&](access_token|refresh_token|id_token|token|api_key|apikey|key|sig|signature|x-amz-signature|x-amz-credential|secret|code)=)[^&\s"''\[]+',
    '\1[redacted]', 'gi');
  return result;
end
$$;

create function pg_temp.drill_scrub_json(value jsonb) returns jsonb
language plpgsql immutable as $$
declare
  result jsonb;
  item record;
  is_email_step boolean;
begin
  if value is null then return null; end if;
  case jsonb_typeof(value)
    when 'object' then
      is_email_step := value ->> 'type' = 'email.send';
      result := '{}'::jsonb;
      for item in select key, val from jsonb_each(value) as e(key, val) loop
        if is_email_step and item.key = 'to' then -- rule:workflow-email
          result := result || jsonb_build_object(item.key, 'redacted@drill.invalid');
        elsif pg_temp.drill_sensitive_key(item.key)
          and (jsonb_typeof(item.val) in ('object', 'array') or (jsonb_typeof(item.val) = 'string' and item.val #>> '{}' <> '')) then
          result := result || jsonb_build_object(item.key, '[redacted]');
        else
          result := result || jsonb_build_object(item.key, pg_temp.drill_scrub_json(item.val));
        end if;
      end loop;
      return result;
    when 'array' then
      select coalesce(jsonb_agg(pg_temp.drill_scrub_json(element) order by position), '[]'::jsonb)
      into result
      from jsonb_array_elements(value) with ordinality as a(element, position);
      return result;
    when 'string' then
      return to_jsonb(pg_temp.drill_scrub_text(value #>> '{}'));
    else
      return value;
  end case;
end
$$;

-- A value is clean when scrubbing it changes nothing.
create function pg_temp.drill_json_is_sensitive(value jsonb) returns boolean
language sql immutable as $$
  select value is not null and pg_temp.drill_scrub_json(value) is distinct from value
$$;

-- The carried columns the generic scrub and checks cover.
create function pg_temp.drill_carried_columns()
returns table (schema_name text, table_name text, column_name text, kind text)
language sql stable as $$
  select n.nspname::text, c.relname::text, a.attname::text,
    case
      when t.typname in ('json', 'jsonb') then t.typname::text
      when t.typcategory = 'A' and et.typname in ('text', 'varchar', 'bpchar') then 'text[]'
      else 'text'
    end
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
  where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    and (n.nspname = 'public'
      or (n.nspname = 'auth' and c.relname in ('users', 'identities'))
      or (n.nspname = 'storage' and c.relname in ('buckets', 'objects')))
    and (t.typname in ('json', 'jsonb', 'text', 'varchar', 'bpchar')
      or (t.typcategory = 'A' and et.typname in ('text', 'varchar', 'bpchar')))
$$;

-- Rows (summed over carried columns) that still hold a sensitive value.
create function pg_temp.drill_count_sensitive(only_kind text) returns bigint
language plpgsql stable as $$
declare
  col record;
  hits bigint;
  total bigint := 0;
begin
  for col in select * from pg_temp.drill_carried_columns()
             where (only_kind = 'json' and kind in ('json', 'jsonb'))
                or (only_kind = 'text' and kind in ('text', 'text[]')) loop
    if col.kind in ('json', 'jsonb') then
      execute format('select count(*) from %I.%I where pg_temp.drill_json_is_sensitive(%I::jsonb)',
        col.schema_name, col.table_name, col.column_name) into hits;
    elsif col.kind = 'text[]' then
      execute format('select count(*) from %I.%I where pg_temp.drill_has_secret_text(array_to_string(%I, chr(10)))',
        col.schema_name, col.table_name, col.column_name) into hits;
    else
      execute format('select count(*) from %I.%I where pg_temp.drill_has_secret_text(%I::text)',
        col.schema_name, col.table_name, col.column_name) into hits;
    end if;
    total := total + hits;
  end loop;
  return total;
end
$$;

create function pg_temp.drill_scrub_json_columns() returns void
language plpgsql as $$
declare
  col record;
begin
  for col in select * from pg_temp.drill_carried_columns() where kind in ('json', 'jsonb') loop
    execute format(
      'update %1$I.%2$I set %3$I = pg_temp.drill_scrub_json(%3$I::jsonb)::%4$s where pg_temp.drill_json_is_sensitive(%3$I::jsonb)',
      col.schema_name, col.table_name, col.column_name, col.kind);
  end loop;
end
$$;

create function pg_temp.drill_scrub_text_columns() returns void
language plpgsql as $$
declare
  col record;
begin
  for col in select * from pg_temp.drill_carried_columns() where kind in ('text', 'text[]') loop
    if col.kind = 'text[]' then
      execute format(
        'update %1$I.%2$I set %3$I = array(select pg_temp.drill_scrub_text(x) from unnest(%3$I) with ordinality as u(x, i) order by i) where pg_temp.drill_has_secret_text(array_to_string(%3$I, chr(10)))',
        col.schema_name, col.table_name, col.column_name);
    else
      execute format(
        'update %1$I.%2$I set %3$I = pg_temp.drill_scrub_text(%3$I) where pg_temp.drill_has_secret_text(%3$I::text)',
        col.schema_name, col.table_name, col.column_name);
    end if;
  end loop;
end
$$;
