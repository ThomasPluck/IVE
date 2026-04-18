# Golden-output end-to-end tests

Each subdirectory under `test/golden/repos/` is a tiny self-contained
workspace. For each one, CI runs the full daemon scan (parse → health →
hallucination → cross-file → binding) and compares the output against
the snapshot in `test/golden/snapshots/<repo>.json`.

## Why

Unit tests cover components in isolation; fixture tests assert
invariants per check. Golden tests catch **drift across the whole
pipeline** — a harmless-looking change in scoring weights or
lockfile-parse edge cases shows up as a snapshot diff and has to be
explicitly approved.

## Invalidating a golden

Snapshots should be updated deliberately, not mechanically:

```bash
IVE_GOLDEN_UPDATE=1 cargo test --release --test golden
git diff test/golden/snapshots/
```

Review the diff line-by-line. If the change is legitimate (e.g. a new
analyzer fired, or a weight tuning), commit the updated snapshot along
with the code change in the same PR. If it's accidental, revert.

## What's captured

The snapshot is a deterministic JSON:

- sorted `files: [{ path, loc, functions: [name, cc] }]`
- sorted `diagnostics: [{ file, line, code, severity, message_prefix }]`
- sorted `file_scores: [{ path, bucket, composite_rounded }]`

Floating-point composites are rounded to 2 decimals so trivial FP
re-ordering on different CPUs doesn't thrash the snapshot. Paths are
workspace-relative POSIX. External subprocess diagnostics (Pyright,
Semgrep) are excluded so the test can run in CI without either binary.
