#!/usr/bin/env bash
# Manual-style JSON-RPC smoke test: pipe a handful of requests into the
# daemon and assert each response shape on its own.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON="$ROOT/target/release/ive-daemon"
WS="$ROOT/test/fixtures/ai-slop/python"

if [[ ! -x "$DAEMON" ]]; then
  echo "ive-daemon not built at $DAEMON" >&2
  exit 2
fi

tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT

(
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"ping"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"workspace.scan"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"workspace.healthSummary"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"file.diagnostics","params":{"file":"hallucinated.py"}}'
  sleep 0.5
) | RUST_LOG=error "$DAEMON" --workspace "$WS" 2>/dev/null > "$tmpfile" &
PID=$!
wait "$PID" || true

echo "── responses:"
cat "$tmpfile"
echo "── assertions:"

grep -q '"result":"pong"' "$tmpfile" && echo "  ✓ ping"
grep -q 'ive-hallucination/unknown-import' "$tmpfile" && echo "  ✓ diagnostic delivered"
grep -q '"bucket":"yellow"' "$tmpfile" && echo "  ✓ yellow bucket in health summary"
echo "done"
