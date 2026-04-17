// End-to-end test: drive the built MCP server over stdio the way Claude
// Desktop / Cursor would. Spins up a tempdir workspace with a deliberate
// hallucinated import, then calls tools/list → tools/call ive_scan →
// tools/call ive_diagnostics and asserts the hallucination diagnostic
// round-trips through the full pipeline:
//   MCP client <-> ive-mcp server <-> ive-daemon subprocess
//
// MCP's stdio transport is newline-delimited JSON — one JSON object per
// line, no Content-Length framing (that's LSP).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DAEMON_BIN = path.resolve(__dirname, "..", "..", "target", "release", "ive-daemon");
const SERVER_BIN = path.resolve(__dirname, "..", "dist", "server.js");

const maybe =
  fs.existsSync(DAEMON_BIN) && fs.existsSync(SERVER_BIN) ? describe : describe.skip;

maybe("ive-mcp (stdio MCP server)", () => {
  let tmp: string;
  let child: ChildProcessWithoutNullStreams;
  let buf = "";
  let nextId = 1;
  const pending = new Map<number, (msg: unknown) => void>();

  function send(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
    child.stdin.write(frame + "\n");
    return new Promise((resolve) => pending.set(id, resolve));
  }

  function notify(method: string, params?: unknown): void {
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} });
    child.stdin.write(frame + "\n");
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ive-mcp-test-"));
    fs.writeFileSync(path.join(tmp, "requirements.txt"), "requests==2.31.0\n");
    fs.writeFileSync(
      path.join(tmp, "app.py"),
      [
        "import os",
        "import huggingface_utils  # hallucinated",
        "",
        "def greet(n):",
        "    return f'hello {n}'",
        "",
      ].join("\n"),
    );
    child = spawn(
      process.execPath,
      [SERVER_BIN, "--workspace", tmp, "--daemon", DAEMON_BIN],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (typeof msg.id === "number") {
            const cb = pending.get(msg.id);
            if (cb) {
              pending.delete(msg.id);
              cb(msg);
            }
          }
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr.on("data", () => {});

    const init = (await send("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "ive-mcp-test", version: "0.0.0" },
      capabilities: {},
    })) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBeTypeOf("string");
    notify("notifications/initialized");
  }, 30_000);

  afterAll(async () => {
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("tools/list returns the IVE tool catalogue", async () => {
    const res = (await send("tools/list")) as {
      result: { tools: { name: string }[] };
    };
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain("ive_scan");
    expect(names).toContain("ive_diagnostics");
    expect(names).toContain("ive_health");
    expect(names).toContain("ive_summarize");
    expect(names).toContain("ive_slice");
    expect(names).toContain("ive_capabilities");
    expect(names).toContain("ive_worst");
    expect(names).toContain("ive_rescan");
    expect(names).toContain("ive_list_files");
    expect(names).toContain("ive_daemon_info");
  });

  it("ive_scan + ive_diagnostics round-trip the hallucination diag", async () => {
    const scanRes = (await send("tools/call", {
      name: "ive_scan",
      arguments: {},
    })) as { result: { content: { text: string }[] } };
    const scanSummary = JSON.parse(scanRes.result.content[0].text);
    expect(scanSummary.files).toBeGreaterThanOrEqual(1);

    const diagRes = (await send("tools/call", {
      name: "ive_diagnostics",
      arguments: { file: "app.py" },
    })) as { result: { content: { text: string }[] } };
    const diags = JSON.parse(diagRes.result.content[0].text) as {
      code: string;
      severity: string;
      message: string;
    }[];
    const hall = diags.find((d) => d.code === "ive-hallucination/unknown-import");
    expect(hall, "expected one hallucination diagnostic").toBeDefined();
    expect(hall!.severity).toBe("critical");
    expect(hall!.message).toContain("huggingface_utils");
  });

  it("ive_worst returns the worst-scored file", async () => {
    const res = (await send("tools/call", {
      name: "ive_worst",
      arguments: {},
    })) as { result: { content: { text: string }[] } };
    const worst = JSON.parse(res.result.content[0].text);
    expect(worst.bucket).toMatch(/yellow|red/);
    expect(worst.location.file).toBe("app.py");
  });

  it("ive_capabilities reports at least cpg, pyright, semgrep", async () => {
    const res = (await send("tools/call", {
      name: "ive_capabilities",
      arguments: {},
    })) as { result: { content: { text: string }[] } };
    const caps = JSON.parse(res.result.content[0].text);
    expect(caps).toHaveProperty("cpg");
    expect(caps).toHaveProperty("pyright");
    expect(caps).toHaveProperty("semgrep");
    expect(caps).toHaveProperty("llm");
  });
});
