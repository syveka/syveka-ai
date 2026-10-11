#!/usr/bin/env bash
# Evidence helper (ci/voice-postgres-evidence only): passes only when the named test
# fails, and fails on the labelled assertion. Usage: <file> <test name> <assertion label>
set -uo pipefail
file="$1" name="$2" label="$3"
out="$(npx vitest run "$file" -t "$name" 2>&1)"
status=$?
printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E "AssertionError|→" || true
if [ "$status" -eq 0 ]; then
  echo "::error::'$name' passed on previous code; the regression did not reproduce"; exit 1
fi
if ! printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -q "AssertionError: $label"; then
  echo "::error::'$name' failed, but not on '$label'; that is not evidence of the defect"; exit 1
fi
echo "Reproduced on previous code: '$name' fails on '$label'."
