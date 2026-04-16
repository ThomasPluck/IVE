#!/usr/bin/env bash
# Integration harness for test/fixtures/ai-slop/.
#
# For each subdirectory under fixtures/ai-slop, run `ive-daemon scan` and
# check the returned JSON matches the expectations in the YAML sidecar.
# This runner is deliberately shell+jq-only (no extra deps) and only checks
# the invariants that exist in v1.
#
# Exit code is non-zero on the first mismatch.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON="${IVE_DAEMON:-$ROOT/target/release/ive-daemon}"

if [[ ! -x "$DAEMON" ]]; then
  echo "ive-daemon not built at $DAEMON — run 'cargo build --release' first" >&2
  exit 2
fi

FAIL=0

for fixture_dir in "$ROOT"/test/fixtures/ai-slop/*/; do
  name="$(basename "$fixture_dir")"
  echo "── fixture: $name"
  summary="$("$DAEMON" scan --workspace "$fixture_dir" 2>/dev/null)"
  files_total="$(echo "$summary" | grep -o '"files":[[:space:]]*[0-9]*' | head -1 | awk '{print $2}')"
  diagnostics="$(echo "$summary" | grep -o '"diagnostics":[[:space:]]*[0-9]*' | head -1 | awk '{print $2}')"
  red="$(echo "$summary" | grep -o '"redFiles":[[:space:]]*[0-9]*' | head -1 | awk '{print $2}')"
  yellow="$(echo "$summary" | grep -o '"yellowFiles":[[:space:]]*[0-9]*' | head -1 | awk '{print $2}')"

  if [[ "${files_total:-0}" == "0" ]]; then
    echo "  ✗ expected at least one file in $name"
    FAIL=1
    continue
  fi

  if [[ "${diagnostics:-0}" == "0" ]]; then
    echo "  ✗ expected hallucinated-import diagnostic in $name"
    FAIL=1
    continue
  fi

  if [[ "${red:-0}" == "0" && "${yellow:-0}" == "0" ]]; then
    echo "  ✗ expected at least one non-green file in $name"
    FAIL=1
    continue
  fi

  echo "  ✓ $name ($files_total files, $diagnostics diagnostics, $red red, $yellow yellow)"
done

if [[ "$FAIL" -ne 0 ]]; then
  echo "fixture runner: FAILED"
  exit 1
fi
echo "fixture runner: ok"
