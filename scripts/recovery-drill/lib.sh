# Shared helpers for the recovery-drill scripts. Sourced, never executed.
# Pure text processing: nothing here connects to a database or runs Docker.

# validate_checks <expected-checks.txt> <checks-output> [complete]
# Compares sanitize-checks.sql output with the expected check list.
# Default mode: every expected check appears exactly once and passes
# (0, or ABSENT for zero-absent checks). "complete" mode only requires every
# check to be present exactly once with a count or ABSENT (used to record
# counts before sanitization). Unknown or malformed lines always fail.
# Prints one line per problem; returns 0 only when there are none.
validate_checks() {
  local expected_file=$1 output_file=$2 mode=${3:-strict}
  awk -F'|' -v mode="$mode" '
    FNR == NR {
      if ($0 ~ /^[[:space:]]*(#|$)/) next
      split($0, field, " ")
      rule[field[1]] = field[2]
      order[++n] = field[1]
      next
    }
    $0 == "" { next }
    $1 != "check" || NF != 3 { print "FAIL malformed output line: " $0; bad = 1; next }
    {
      name = $2; value = $3
      seen[name]++
      if (!(name in rule)) { print "FAIL unknown check: " name; bad = 1; next }
      if (seen[name] > 1) { print "FAIL duplicate check: " name; bad = 1; next }
      if (value !~ /^[0-9]+$/ && value != "ABSENT") { print "FAIL " name " = " value; bad = 1; next }
      if (value == "ABSENT" && rule[name] != "zero-absent") { print "FAIL " name " = ABSENT (table must exist)"; bad = 1; next }
      if (mode == "complete") next
      if (value != "0" && value != "ABSENT") { print "FAIL " name " = " value " (must be 0)"; bad = 1 }
    }
    END {
      if (n == 0) { print "FAIL expected check list is empty"; bad = 1 }
      for (i = 1; i <= n; i++) if (!(order[i] in seen)) { print "FAIL missing check: " order[i]; bad = 1 }
      exit bad
    }
  ' "$expected_file" "$output_file"
}

# A pg_restore --list line is "<id>; <tableoid> <oid> <TYPE> <schema> <tag...> <owner>".
# toc_body strips the numeric prefix and drops comment lines.
toc_body() {
  sed -n -E 's/^[0-9]+; [0-9]+ [0-9]+ //p'
}

# Entries of the public schema, without the schema object itself (the
# destination already has its own public schema, its comment and its grants)
# and without other roles' default privileges: only the connecting role
# (postgres) can alter its own, and the platform roles' defaults (for example
# supabase_admin's) come from the destination platform.
toc_select_public() {
  grep -E '^[0-9]+; [0-9]+ [0-9]+ [A-Z]+( [A-Z]+)* public ' \
    | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public|ACL - SCHEMA public) ' \
    | awk '!/^[0-9]+; [0-9]+ [0-9]+ DEFAULT ACL public / || $NF == "postgres"'
}

# Data of the four Supabase-managed tables a drill carries. Definitions are
# never restored into a destination: the destination's Auth and Storage
# services own those schemas. Printed parents first (pg_restore -L restores in
# list order, and the archive lists auth.identities before auth.users), so
# the destination's foreign keys hold while the rows load.
toc_select_managed_data() {
  local include_storage=${1:-1} listing table
  listing=$(cat)
  local tables=('auth users' 'auth identities')
  [ "$include_storage" = 1 ] && tables+=('storage buckets' 'storage objects')
  for table in "${tables[@]}"; do
    printf '%s\n' "$listing" | grep -E "^[0-9]+; [0-9]+ [0-9]+ TABLE DATA $table "
  done
  return 0
}

# The application's own trigger on auth.users (prisma migration
# 20260719000000_initial_security_baseline). Restored after the data, so it
# does not fire for the restored rows.
toc_select_auth_trigger() {
  grep -E '^[0-9]+; [0-9]+ [0-9]+ TRIGGER auth users on_auth_user_created '
}

# Everything in an archive except the public schema object (s5's isolated
# container restores the whole raw dump, including the auth and storage
# definitions, into an empty server).
toc_select_all_but_public_schema() {
  grep -E '^[0-9]+; ' \
    | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public|ACL - SCHEMA public) '
}

# detect_extensions: reads schema-only SQL (pg_restore -s -f -) on stdin and
# prints "<extension> <schema>" for each extension the objects reference.
# pg_dump schema-qualifies every reference, so the qualifier is the
# extension's schema. Fails if one extension appears under two schemas.
detect_extensions() {
  awk '
    function note(ext, sch) { if (sch != "pg_catalog") found[ext "|" sch] = 1 }
    {
      line = $0
      while (match(line, /[a-z_][a-z0-9_]*\.(vector|halfvec|sparsevec)([^a-z0-9_]|$)/)) {
        token = substr(line, RSTART, RLENGTH); split(token, part, "."); note("vector", part[1])
        line = substr(line, RSTART + RLENGTH)
      }
      line = $0
      while (match(line, /[a-z_][a-z0-9_]*\.(gin_trgm_ops|gist_trgm_ops|similarity|word_similarity|show_trgm)([^a-z0-9_]|$)/)) {
        token = substr(line, RSTART, RLENGTH); split(token, part, "."); note("pg_trgm", part[1])
        line = substr(line, RSTART + RLENGTH)
      }
      line = $0
      while (match(line, /[a-z_][a-z0-9_]*\.(digest|hmac|crypt|gen_salt|gen_random_bytes|pgp_sym_encrypt|pgp_sym_decrypt|armor|dearmor)\(/)) {
        token = substr(line, RSTART, RLENGTH); split(token, part, "."); note("pgcrypto", part[1])
        line = substr(line, RSTART + RLENGTH)
      }
      line = $0
      while (match(line, /[a-z_][a-z0-9_]*\.uuid_generate_v[1-5]\(/)) {
        token = substr(line, RSTART, RLENGTH); split(token, part, "."); note("uuid-ossp", part[1])
        line = substr(line, RSTART + RLENGTH)
      }
    }
    END {
      for (key in found) { split(key, kv, "|"); count[kv[1]]++; schema_of[kv[1]] = kv[2] }
      for (ext in count) {
        if (count[ext] > 1) { print "AMBIGUOUS " ext; bad = 1 } else print ext " " schema_of[ext]
      }
      exit bad
    }
  ' | sort
}

# compare_rowcounts <expected> <actual>: identical sorted "rows|..." lines.
compare_rowcounts() {
  diff <(grep '^rows|' "$1" | sort) <(grep '^rows|' "$2" | sort)
}

# pending_migrations <migrations-dir> <applied-names-file>: migration
# directories at this commit that are not recorded as applied.
pending_migrations() {
  local dir=$1 applied=$2
  find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort \
    | comm -23 - <(sort "$applied")
}
