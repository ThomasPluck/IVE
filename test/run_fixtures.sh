#!/usr/bin/env bash
# Integration harness for test/fixtures/ai-slop/.
#
# For each subdirectory, run `ive-daemon scan` and check the returned JSON
# satisfies a generic non-green invariant. Detailed per-analyzer expectations
# live in daemon/tests/fixtures.rs — this script is the end-to-end smoke
# check that the released binary's wiring still works.
#
# Fixtures that depend on an external analyzer binary (rust-analyzer,
# semgrep, pyright, tsc) are skipped when that binary isn't on PATH so a
# minimal install doesn't fail CI for missing optional capabilities.
#
# Exit code is non-zero on the first hard mismatch.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON="${IVE_DAEMON:-$ROOT/target/release/ive-daemon}"

if [[ ! -x "$DAEMON" ]]; then
  echo "ive-daemon not built at $DAEMON — run 'cargo build --release' first" >&2
  exit 2
fi

# Map fixture name → required external binary. Empty string means the
# fixture relies only on the daemon's built-in analyzers (hallucination,
# crossfile, binding) and must always produce diagnostics.
required_binary() {
  case "$1" in
    rust_analyzer) echo rust-analyzer ;;
    semgrep)       echo semgrep       ;;
    pyright)       echo pyright       ;;
    tsc)           echo tsc           ;;
    *)             echo ""            ;;
  esac
}

FAIL=0

for fixture_dir in "$ROOT"/test/fixtures/ai-slop/*/; do
  name="$(basename "$fixture_dir")"
  echo "── fixture: $name"

  required="$(required_binary "$name")"
  if [[ -n "$required" ]] && ! command -v "$required" >/dev/null 2>&1; then
    echo "  ⤳ skipped: required binary '$required' not on PATH (covered by cargo tests when installed)"
    continue
  fi

  # Capture stderr so a daemon panic or analyzer error is visible on failure.
  stderr_log="$(mktemp)"
  summary="$("$DAEMON" scan --workspace "$fixture_dir" 2>"$stderr_log")"
  files_total="$(echo "$summary" | grep -o '"files":[[:space:]]*[0-9]*' | head -1 | awk '{print $2}')"
  diagnostics="$(echo "$summary" | grep -o '"diagnostics":[[:space:]]*[0-9]*' | head -1 | awk '{print $2}')"
  red="$(echo "$summary" | grep -o '"redFiles":[[:space:]]*[0-9]*' | head -1 | awk '{print $2}')"
  yellow="$(echo "$summary" | grep -o '"yellowFiles":[[:space:]]*[0-9]*' | head -1 | awk '{print $2}')"

  fail_with() {
    echo "  ✗ $1 in $name"
    if [[ -s "$stderr_log" ]]; then
      echo "  ── daemon stderr ──"
      sed 's/^/    /' "$stderr_log"
    fi
    rm -f "$stderr_log"
    FAIL=1
  }

  if [[ "${files_total:-0}" == "0" ]]; then
    fail_with "expected at least one file"
    continue
  fi

  if [[ "${diagnostics:-0}" == "0" ]]; then
    fail_with "expected at least one diagnostic"
    continue
  fi

  if [[ "${red:-0}" == "0" && "${yellow:-0}" == "0" ]]; then
    fail_with "expected at least one non-green file"
    continue
  fi

  rm -f "$stderr_log"
  echo "  ✓ $name ($files_total files, $diagnostics diagnostics, $red red, $yellow yellow)"
done

if [[ "$FAIL" -ne 0 ]]; then
  echo "fixture runner: FAILED"
  exit 1
fi
echo "fixture runner: ok"
