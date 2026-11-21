#!/usr/bin/env bash
# Gate a headless Strix run: pass only when THIS invocation produced exactly one
# complete run and the scanner exited 0.
#
# Usage: verify-run.sh <strix_runs-dir> <scanner-exit-code> <marker-file>
#   <marker-file> is a file touched immediately BEFORE `strix` started; only a
#   run.json newer than it counts as this invocation's output.
#
# Exit codes: 0 pass; 2 validated findings reported by the scanner; 1 any other
# failure (fatal scanner error, unexpected exit code, missing/stale/malformed
# output, run not "completed", e.g. stopped by --max-budget or --max-turns).
#
# Semantics verified against strix-agent 1.7.0 (strix/interface/main.py,
# strix/report/state.py): headless exit 1 = fatal error, 2 = findings at or
# above --fail-on, 0 = no such findings. A run cut short by the budget or turn
# cap still exits 0 (or 2) with run.json "status" of "stopped"; a crash leaves
# "failed"; Ctrl-C leaves "interrupted"; only finish_scan writes "completed".
set -uo pipefail

runs_dir="${1:-}"
scanner_exit="${2:-}"
marker="${3:-}"

fail() {
  echo "verify-run: FAIL: $*" >&2
  exit 1
}

if [ -z "$runs_dir" ] || [ -z "$scanner_exit" ] || [ -z "$marker" ]; then
  fail "usage: verify-run.sh <strix_runs-dir> <scanner-exit-code> <marker-file>"
fi
case "$scanner_exit" in
  '' | *[!0-9]*) fail "scanner exit code is not an integer: '$scanner_exit'" ;;
esac
[ -f "$marker" ] || fail "marker file not found: $marker"

# Pick a working interpreter: on Windows a `python3` stub may exist that only
# opens the Microsoft Store, so each candidate is exercised, not just found.
PY=""
for cand in python3 python; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import json' >/dev/null 2>&1; then
    PY=$cand
    break
  fi
done
[ -n "$PY" ] || fail "a working python3 is required to parse run.json"

# 1. The scanner's own exit code. 1 and anything unexpected is fatal regardless
#    of what is on disk; 2 is evaluated after the output checks so the report
#    is still validated as this run's.
case "$scanner_exit" in
  0 | 2) ;;
  1) fail "strix exited 1 (fatal error before or during the scan)" ;;
  *) fail "strix exited with unexpected code $scanner_exit" ;;
esac

# 2. Exactly one run, produced after the marker; no stale runs from earlier
#    invocations may be present.
[ -d "$runs_dir" ] || fail "runs directory not found: $runs_dir (no output was produced)"
all_records=()
while IFS= read -r -d '' f; do all_records+=("$f"); done < <(
  find "$runs_dir" -mindepth 2 -maxdepth 2 -type f -name run.json -print0 2>/dev/null
)
[ "${#all_records[@]}" -gt 0 ] || fail "no run.json under $runs_dir (no output was produced)"
[ "${#all_records[@]}" -eq 1 ] || fail "${#all_records[@]} run.json files under $runs_dir; stale runs present, refusing to pick one"
record="${all_records[0]}"
[ "$record" -nt "$marker" ] || fail "run.json is older than the start marker; stale output from an earlier invocation"
run_dir=$(dirname "$record")

# 3. run.json must be a JSON object from a finished, non-interactive run whose
#    status is "completed" (not stopped/failed/interrupted/running).
status=$("$PY" - "$record" "$(basename "$run_dir")" <<'PYEOF'
import json, sys
path, dirname = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as fh:
        rec = json.load(fh)
except Exception as exc:  # noqa: BLE001
    print(f"MALFORMED: {exc}")
    sys.exit(0)
if not isinstance(rec, dict):
    print("MALFORMED: run.json is not an object")
    sys.exit(0)
status = rec.get("status")
problems = []
if status != "completed":
    problems.append(f"status is {status!r}, not 'completed'")
if not rec.get("end_time"):
    problems.append("end_time is empty")
if rec.get("non_interactive") is not True:
    problems.append("non_interactive is not true")
if rec.get("run_name") != dirname:
    problems.append(f"run_name {rec.get('run_name')!r} does not match directory {dirname!r}")
print("OK" if not problems else "BAD: " + "; ".join(problems))
PYEOF
)
case "$status" in
  OK) ;;
  *) fail "run.json at $record rejected: $status" ;;
esac

# 4. The report artifacts of this run must exist.
report="$run_dir/penetration_test_report.md"
[ -s "$report" ] || fail "missing or empty report: $report"

# 5. Findings reported by the scanner fail the gate at the configured threshold.
if [ "$scanner_exit" -eq 2 ]; then
  echo "verify-run: FAIL: strix exited 2: validated findings at or above --fail-on in $run_dir" >&2
  exit 2
fi

echo "verify-run: PASS: run $(basename "$run_dir") completed; no findings at or above --fail-on"
exit 0
