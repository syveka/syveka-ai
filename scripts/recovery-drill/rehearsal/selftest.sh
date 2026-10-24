#!/usr/bin/env bash
# Offline self-test of lib.sh (no Docker, no database): the check validator
# must pass a clean result and fail every kind of incomplete or dirty one, and
# the archive-list filters must select exactly the intended entries.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../lib.sh
. "$HERE/lib.sh"
EXPECTED="$HERE/expected-checks.txt"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fails=0
ok() { printf 'PASS %s\n' "$1"; }
ko() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
expect_pass() { if "${@:2}" > "$T/out" 2>&1; then ok "$1"; else ko "$1"; cat "$T/out"; fi; }
expect_fail() { if "${@:2}" > "$T/out" 2>&1; then ko "$1 (was accepted)"; else ok "$1 -> $(head -1 "$T/out")"; fi; }

# A clean result: every expected check, 0 (ABSENT only where allowed).
awk '!/^[[:space:]]*(#|$)/ { v = ($2 == "zero-absent" && NR % 2) ? "ABSENT" : "0"; print "check|" $1 "|" v }' "$EXPECTED" > "$T/clean"
expect_pass "clean result passes" validate_checks "$EXPECTED" "$T/clean"
sed '1d' "$T/clean" > "$T/missing";                          expect_fail "a missing check fails" validate_checks "$EXPECTED" "$T/missing"
sed 's/^check|webhook_endpoints|0$/check|webhook_endpoints|1/' "$T/clean" > "$T/nonzero"
expect_fail "a non-zero forbidden-data count fails" validate_checks "$EXPECTED" "$T/nonzero"
{ cat "$T/clean"; echo 'check|webhook_endpoints|0'; } > "$T/dup"; expect_fail "a duplicated check fails" validate_checks "$EXPECTED" "$T/dup"
{ cat "$T/clean"; echo 'check|surprise|0'; } > "$T/unknown";     expect_fail "an unknown check fails" validate_checks "$EXPECTED" "$T/unknown"
sed 's/^check|auth_user_secrets|0$/check|auth_user_secrets|MISSING_COLUMN/' "$T/clean" > "$T/missingcol"
expect_fail "auth.users without encrypted_password fails" validate_checks "$EXPECTED" "$T/missingcol"
sed 's/^check|stripe_ids|0$/check|stripe_ids|ABSENT/' "$T/clean" > "$T/absent"
expect_fail "ABSENT for a required table fails" validate_checks "$EXPECTED" "$T/absent"
{ cat "$T/clean"; echo 'ERROR:  relation "public.x" does not exist'; } > "$T/garbage"
expect_fail "a malformed line fails" validate_checks "$EXPECTED" "$T/garbage"
: > "$T/empty";                                              expect_fail "empty output fails" validate_checks "$EXPECTED" "$T/empty"
sed 's/|0$/|7/' "$T/clean" > "$T/raw"
expect_pass "complete mode accepts counts before sanitizing" validate_checks "$EXPECTED" "$T/raw" complete
expect_fail "complete mode still fails a missing check" validate_checks "$EXPECTED" "$T/missing" complete

cat > "$T/listing" <<'EOF'
;
; Archive created at 2026-10-24 00:00:00 UTC
3; 2615 2200 SCHEMA - public pg_database_owner
4; 0 0 COMMENT - SCHEMA public pg_database_owner
5; 0 0 ACL - SCHEMA public pg_database_owner
10; 1259 100 TABLE public organizations postgres
11; 1259 101 TABLE public _prisma_migrations postgres
12; 0 100 TABLE DATA public organizations postgres
13; 2606 102 CONSTRAINT public organizations organizations_pkey postgres
14; 0 0 ACL public TABLE organizations postgres
15; 826 103 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES postgres
16; 826 104 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES supabase_admin
20; 1259 200 TABLE auth users supabase_auth_admin
21; 0 200 TABLE DATA auth users supabase_auth_admin
19; 0 201 TABLE DATA auth identities supabase_auth_admin
23; 0 202 TABLE DATA auth sessions supabase_auth_admin
24; 0 203 TABLE DATA auth refresh_tokens supabase_auth_admin
25; 0 300 TABLE DATA storage buckets supabase_storage_admin
26; 0 301 TABLE DATA storage objects supabase_storage_admin
27; 2620 204 TRIGGER auth users on_auth_user_created postgres
28; 2620 205 TRIGGER auth users some_other_trigger postgres
EOF
[ "$(toc_select_public < "$T/listing" | awk '{print $1}' | tr '\n' ' ')" = "10; 11; 12; 13; 14; 15; " ] \
  && ok "public filter keeps public objects and postgres's default ACLs, drops the schema entries and other roles' default ACLs" || ko "public filter"
[ "$(toc_select_managed_data 1 < "$T/listing" | awk '{print $1}' | tr '\n' ' ')" = "21; 19; 25; 26; " ] \
  && ok "managed filter keeps users/identities/buckets/objects data only, parents first" || ko "managed filter"
[ "$(toc_select_managed_data 0 < "$T/listing" | awk '{print $1}' | tr '\n' ' ')" = "21; 19; " ] \
  && ok "managed filter without storage metadata" || ko "managed filter without storage"
[ "$(toc_select_auth_trigger < "$T/listing" | awk '{print $1}')" = "27;" ] \
  && ok "trigger filter keeps only on_auth_user_created" || ko "trigger filter"
toc_select_all_but_public_schema < "$T/listing" | grep -qE 'SCHEMA - public|SCHEMA public' \
  && ko "s5 filter kept the public schema entry" || ok "s5 filter drops only the public schema entries"

printf '%s\n' 'CREATE TABLE public.document_chunks (embedding public.vector(1536));' \
  'CREATE INDEX x ON public.contacts USING gin (name public.gin_trgm_ops);' \
  'CREATE TABLE auth.flow_state (id uuid DEFAULT extensions.uuid_generate_v4());' > "$T/schema.sql"
[ "$(detect_extensions < "$T/schema.sql" | tr '\n' ',')" = "pg_trgm public,uuid-ossp extensions,vector public," ] \
  && ok "extension detection reads schema qualifiers" || ko "extension detection: $(detect_extensions < "$T/schema.sql" | tr '\n' ',')"
printf '%s\n' 'a public.vector(3)' 'b extensions.vector(3)' > "$T/ambiguous.sql"
expect_fail "an extension referenced in two schemas fails" detect_extensions < "$T/ambiguous.sql"

mkdir -p "$T/migrations/001_a" "$T/migrations/002_b" "$T/migrations/003_c"
printf '%s\n' 001_a 002_b > "$T/applied"
[ "$(pending_migrations "$T/migrations" "$T/applied")" = "003_c" ] && ok "pending migrations" || ko "pending migrations"

# Remote target identity (no network): only the expected disposable project passes.
H=aws-0-eu-west-1.pooler.supabase.com; E=eeeeeeeeeeeeeeeeeeee; P=pppppppppppppppppppp; S=ssssssssssssssssssss
expect_pass "remote identity: the expected disposable project passes" validate_remote_target "$H" "postgres.$E" "$E" "$P" "$S"
expect_fail "remote identity: a production user is refused" validate_remote_target "$H" "postgres.$P" "$E" "$P" "$S"
expect_fail "remote identity: a staging user is refused" validate_remote_target "$H" "postgres.$S" "$E" "$P" "$S"
expect_fail "remote identity: another project is refused" validate_remote_target "$H" "postgres.aaaaaaaaaaaaaaaaaaaa" "$E" "$P" "$S"
expect_fail "remote identity: expected = production is refused" validate_remote_target "$H" "postgres.$P" "$P" "$P" "$S"
expect_fail "remote identity: production = staging is refused" validate_remote_target "$H" "postgres.$E" "$E" "$P" "$P"
expect_fail "remote identity: a direct-database host is refused" validate_remote_target "db.$E.supabase.co" "postgres.$E" "$E" "$P" "$S"
expect_fail "remote identity: a malformed ref is refused" validate_remote_target "$H" "postgres.$E" "short" "$P" "$S"
expect_fail "remote identity: a bare postgres user is refused" validate_remote_target "$H" "postgres" "$E" "$P" "$S"

# Archive-scan patterns: the same secret formats as scrub-functions.sql.
# Vendor-format samples are split ('s''k_live_') so no source line is in a key format.
printf '%s\n' 'key s''k_live_SYNTHETICSECRET0123' 'xo''xb-SYNTHETICSECRET-1234567890' 'ya''29.SYNTHETICSECRET0123' \
  'ey''JSYNTHETICSECRETaa.ey''JSYNTHETICSECRETbb.SYNTHETICSECRETcc' 'wh''sec_SYNTHETICSECRET99' \
  'https://user:pw-SYNTHETIC@tools.invalid/x' > "$T/secrets.txt"
printf '%s\n' 'https://cdn.invalid/a.png?X-Amz-Signature=abc123' 'https://h.invalid/x?token=abc' > "$T/query.txt"
printf '%s\n' 'task-assignment-reminder-for-the-team' 'https://[redacted]@tools.invalid/x' \
  'https://h.invalid/x?token=[redacted]' 'a plain sentence about sk and live tests' > "$T/clean.txt"
[ "$(grep -cE -f "$HERE/secret-patterns.ere" "$T/secrets.txt")" = 6 ] && ok "archive scan finds every synthetic secret format" || ko "archive scan secret formats"
[ "$(grep -ciE -f "$HERE/secret-query.ere" "$T/query.txt")" = 2 ] && ok "archive scan finds signed/token query parameters" || ko "archive scan query parameters"
[ "$( { grep -E -f "$HERE/secret-patterns.ere" "$T/clean.txt"; grep -iE -f "$HERE/secret-query.ere" "$T/clean.txt"; } | wc -l | tr -d ' ')" = 0 ] \
  && ok "archive scan ignores redacted values and look-alike words" || ko "archive scan false positive"

printf 'selftest: %s failure(s)\n' "$fails"
exit "$fails"
