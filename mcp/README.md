# ive-mcp

MCP server that fronts the IVE daemon so Claude Desktop, Claude Code,
Cursor, or any other MCP client can ask the same questions the VSCode
extension asks — "where's the slop?", "what does this function
actually do?", "where did this value come from?" — directly.

## What it exposes

| Tool | Daemon method | Answers |
|---|---|---|
| `ive_scan` | `workspace.scan` + summary | "index the workspace and tell me the bucket counts" |
| `ive_rescan` | `cache.invalidate` + `workspace.scan` | "re-index, ignore the cache" |
| `ive_health` | `workspace.healthSummary` | "rank every file by composite health, worst first" |
| `ive_worst` | `workspace.healthSummary[0]` | "just the single worst-scored file" |
| `ive_diagnostics` | `file.diagnostics` | "every diagnostic — hallucinated imports, type errors, shape errors, Semgrep hits — for one file" |
| `ive_list_files` | `file.list` | "what files is the daemon indexing?" |
| `ive_summarize` | `summary.generate` | "grounded summary of a function, with the entailment gate's verdict on every claim" |
| `ive_slice` | `slice.compute` | "intra-function thin slice from a cursor position (backward or forward)" |
| `ive_capabilities` | `capabilities.status` | "which downstream analyzers are ready right now" |
| `ive_daemon_info` | `daemon.info` | "version + workspace root" |

Every tool returns a `content: [{type:"text", text:"..."}]` block with
JSON inside. Schemas are stable — they mirror `spec §4`.

## Wiring it up

### Claude Desktop / Claude Code

Add to your `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ive": {
      "command": "node",
      "args": [
        "/absolute/path/to/IVE/mcp/dist/server.js",
        "--workspace",
        "/absolute/path/to/your/project"
      ],
      "env": {
        "IVE_DAEMON_PATH": "/absolute/path/to/IVE/target/release/ive-daemon",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Restart Claude. The tools show up under the MCP section; type
"What's the worst file in this repo?" and Claude will call `ive_worst`.

### Cursor

In Cursor's MCP settings:

```json
{
  "ive": {
    "command": "node",
    "args": ["/abs/path/to/IVE/mcp/dist/server.js", "--workspace", "${workspaceFolder}"],
    "env": { "IVE_DAEMON_PATH": "/abs/path/to/IVE/target/release/ive-daemon" }
  }
}
```

### Local dev

```bash
cd mcp
npm ci
npm run build
# Bin lives at mcp/dist/server.js and is marked executable via the
# #!/usr/bin/env node banner — you can run it directly.
./dist/server.js --workspace /tmp/some/repo
```

## How it talks

```
Claude ── MCP stdio (newline-delimited JSON) ── ive-mcp
                                                    │
                                                    └─ spawns ── ive-daemon
                                                                      │
                                                                      ├─ parsers
                                                                      ├─ hallucination
                                                                      ├─ crossfile
                                                                      ├─ pyright / tsc / rust-analyzer
                                                                      ├─ semgrep / pytea
                                                                      └─ grounded summaries + gate
```

The MCP process is a thin adapter. All analysis lives in the Rust
daemon — same binary the VSCode extension uses. If the extension and
the MCP client both target the same workspace root, they see identical
data.

## CLI

```
ive-mcp --workspace <path>              required (or set IVE_WORKSPACE)
        --daemon    <path to ive-daemon> optional (IVE_DAEMON_PATH)
```

Env:
- `IVE_WORKSPACE` — fallback when `--workspace` is omitted
- `IVE_DAEMON_PATH` — daemon binary override
- `IVE_MCP_DEBUG=1` — forward daemon stderr to our stderr
- `ANTHROPIC_API_KEY` — enables the LLM path for `ive_summarize`
- `IVE_ENABLE_JOERN=1` — enables cross-file `ive_slice` via Joern
- `IVE_SKIP_PYRIGHT` / `IVE_SKIP_TSC` / `IVE_SKIP_SEMGREP` / `IVE_SKIP_PYTEA`
  / `IVE_SKIP_RUST_ANALYZER` / `IVE_SKIP_JOERN` — per-analyzer kill switches

## Test

```bash
cd mcp
npm test          # vitest; boots the real daemon + server and asserts round-trips
```
