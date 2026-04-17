// IVE MCP server — fronts the daemon over stdio so Claude (or any MCP
// client) can inspect the same §4 data model the VSCode extension
// sees: health scores, diagnostics, grounded summaries, intra-function
// slices, capability status.
//
// Transport: stdio (the MCP standard). The process also spawns the
// daemon as a child and talks JSON-RPC to it — so a client that
// invokes this binary gets the whole pipeline transparently.
//
// CLI shape:
//   ive-mcp --workspace /path/to/project [--daemon /path/to/ive-daemon]
//
// Environment:
//   IVE_WORKSPACE       — fallback workspace when --workspace is omitted
//   IVE_DAEMON_PATH     — daemon binary override (same semantics as extension)
//   IVE_MCP_DEBUG=1     — forward daemon stderr to our stderr for debugging

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Daemon, findDaemonBinary } from "./daemon";

interface Args {
  workspace: string;
  daemonPath?: string;
}

function parseArgs(argv: string[]): Args {
  let workspace = process.env.IVE_WORKSPACE ?? process.cwd();
  let daemonPath = process.env.IVE_DAEMON_PATH;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace" && argv[i + 1]) workspace = argv[++i];
    else if (a === "--daemon" && argv[i + 1]) daemonPath = argv[++i];
  }
  return { workspace, daemonPath };
}

const TOOLS = [
  {
    name: "ive_scan",
    description:
      "Run a full workspace scan. Returns a summary with file/diagnostic/function counts and the bucket distribution. Call this once at the start of a session; subsequent calls re-scan.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ive_health",
    description:
      "Return the workspace health summary. Each entry carries per-file or per-symbol composite score, bucket (green/yellow/red), and the component breakdown (novelty, cognitive complexity, coupling, AI signal). Sorted by composite desc — the worst stuff first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max entries to return. Defaults to 50.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ive_worst",
    description:
      "Shortcut for the top entry from ive_health. Returns the single worst-scored file and its dominant contributing component, so Claude can drill there immediately.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ive_diagnostics",
    description:
      "Return diagnostics for one workspace-relative file. Covers hallucinated imports, cross-file arity mismatches, WebGL binding errors, Pyright/tsc/rust-analyzer type errors, Semgrep hits, and PyTea shape mismatches — anything that landed in the §4 Diagnostic contract for that file.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Workspace-relative path, POSIX separators.",
        },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "ive_list_files",
    description:
      "List every file the daemon has indexed, with LOC and detected language.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ive_summarize",
    description:
      "Grounded summary for a function symbol. Uses the offline fact-only path by default; if ANTHROPIC_API_KEY is set in the daemon's env, the daemon's grounding module calls Claude with an explicit fact list and runs every claim through the entailment gate. Unentailed claims come back with `entailed: false` and a reason.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description:
            "SymbolId from ive_health (target field when it's a string, not an object). Format: `local . ive <file> <qualified-name>#.`",
        },
        depth: {
          type: "string",
          enum: ["signature", "body", "module"],
          default: "body",
        },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
  {
    name: "ive_slice",
    description:
      "Compute an intra-function thin slice from a cursor position. Returns the list of statements that influence (backward) or are influenced by (forward) the value at the origin. Cross-file slicing needs Joern behind IVE_ENABLE_JOERN — without it, cross_file requests degrade with capability: cpg.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Workspace-relative path." },
        line: { type: "number", description: "0-indexed line number." },
        column: { type: "number", description: "0-indexed column.", default: 0 },
        direction: {
          type: "string",
          enum: ["backward", "forward"],
          default: "backward",
        },
        kind: { type: "string", enum: ["thin", "full"], default: "thin" },
        crossFile: { type: "boolean", default: false },
        maxHops: { type: "number", default: 10 },
      },
      required: ["file", "line"],
      additionalProperties: false,
    },
  },
  {
    name: "ive_capabilities",
    description:
      "Which downstream analyzers are available right now (cpg, pyright, tsc, rust-analyzer, semgrep, pytea, llm). Each entry reports `available` + a human-readable reason.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ive_daemon_info",
    description: "Report the daemon version and resolved workspace root.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ive_rescan",
    description:
      "Invalidate cached results and re-run a full workspace scan. Use after big edits or when you suspect stale data.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

function textBlock(value: unknown) {
  const json =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: json }] };
}

export async function main(): Promise<void> {
  const { workspace, daemonPath } = parseArgs(process.argv.slice(2));
  const bin = findDaemonBinary(daemonPath);
  if (!bin) {
    // Failing-loud on stderr is fine here — the MCP client hasn't attached yet.
    process.stderr.write(
      "ive-mcp: daemon binary not found. Build with `cargo build --release` or pass --daemon <path>.\n",
    );
    process.exit(2);
  }

  const daemon = new Daemon({ binaryPath: bin, workspace, logLevel: "warn" });
  await daemon.start();

  const server = new Server(
    { name: "ive-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "ive_scan": {
          await daemon.call("workspace.scan");
          const scores = await daemon.call<unknown[]>(
            "workspace.healthSummary",
          );
          const files = await daemon.call<unknown[]>("file.list");
          const summary = {
            files: files.length,
            scores: scores.length,
            bucketCounts: bucketCounts(scores),
          };
          return textBlock(summary);
        }
        case "ive_rescan": {
          await daemon.call("cache.invalidate", {});
          await daemon.call("workspace.scan");
          return textBlock({ ok: true });
        }
        case "ive_health": {
          const limit =
            typeof args.limit === "number" ? Math.max(1, args.limit) : 50;
          const scores = await daemon.call<unknown[]>(
            "workspace.healthSummary",
          );
          return textBlock(scores.slice(0, limit));
        }
        case "ive_worst": {
          const scores = await daemon.call<
            { bucket: string; composite: number; location: { file: string } }[]
          >("workspace.healthSummary");
          const worst = scores[0] ?? null;
          return textBlock(worst ?? { error: "no scores yet — call ive_scan first" });
        }
        case "ive_diagnostics": {
          const file = String(args.file ?? "");
          if (!file) throw new Error("`file` is required");
          const diagnostics = await daemon.call("file.diagnostics", { file });
          return textBlock(diagnostics);
        }
        case "ive_list_files": {
          const list = await daemon.call("file.list");
          return textBlock(list);
        }
        case "ive_summarize": {
          const symbol = String(args.symbol ?? "");
          const depth =
            typeof args.depth === "string" ? args.depth : "body";
          if (!symbol) throw new Error("`symbol` is required");
          const summary = await daemon.call("summary.generate", {
            symbol,
            depth,
          });
          return textBlock(summary);
        }
        case "ive_slice": {
          const file = String(args.file ?? "");
          const line = Number(args.line ?? 0);
          const column = Number(args.column ?? 0);
          if (!file) throw new Error("`file` is required");
          const request = {
            origin: {
              file,
              range: { start: [line, column], end: [line, column] },
            },
            direction: (args.direction as string) ?? "backward",
            kind: (args.kind as string) ?? "thin",
            crossFile: Boolean(args.crossFile ?? false),
            maxHops: typeof args.maxHops === "number" ? args.maxHops : 10,
          };
          const slice = await daemon.call("slice.compute", request);
          return textBlock(slice);
        }
        case "ive_capabilities": {
          const caps = await daemon.call("capabilities.status");
          return textBlock(caps);
        }
        case "ive_daemon_info": {
          const info = await daemon.call("daemon.info");
          return textBlock(info);
        }
        default:
          return {
            content: [{ type: "text", text: `unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (e) {
      const message = (e as { message?: string }).message ?? String(e);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep the process alive until the transport closes.
  await new Promise<void>((resolve) => {
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
    transport.onclose = () => resolve();
  });
  await daemon.stop();
}

type BucketBag = { green: number; yellow: number; red: number };

function bucketCounts(scores: unknown[]): BucketBag {
  const out: BucketBag = { green: 0, yellow: 0, red: 0 };
  for (const s of scores) {
    const bucket = (s as { bucket?: string }).bucket;
    if (bucket === "green" || bucket === "yellow" || bucket === "red") {
      out[bucket] += 1;
    }
  }
  return out;
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`ive-mcp fatal: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
