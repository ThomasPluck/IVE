// Spawns and supervises the ive-daemon subprocess, sends line-delimited
// JSON-RPC, and exposes a typed `call(method, params)` for the MCP
// server to use. Mirrors `extension/src/daemon.ts` — same wire format,
// same methods — but trimmed to what the MCP process needs (no event
// fan-out, no panel bridge).

import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DaemonOptions {
  binaryPath: string;
  workspace: string;
  logLevel?: string;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: { code: number; message: string }) => void;
};

export class Daemon {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutBuffer = "";
  private ready: Promise<void>;
  private markReady!: () => void;

  constructor(private readonly opts: DaemonOptions) {
    this.ready = new Promise<void>((r) => (this.markReady = r));
  }

  async start(): Promise<void> {
    if (this.child) return;
    const env: Record<string, string | undefined> = { ...process.env };
    if (this.opts.logLevel) {
      env.RUST_LOG = `ive_daemon=${this.opts.logLevel}`;
    }
    const child = spawn(
      this.opts.binaryPath,
      ["--workspace", this.opts.workspace],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      // Quiet by default — MCP servers mustn't log to stdout (the
      // transport lives there), and stderr noise confuses Claude
      // Desktop's console. Surface only if users opt in.
      if (process.env.IVE_MCP_DEBUG) process.stderr.write(`[daemon] ${chunk}`);
    });
    child.on("exit", (code, signal) => {
      for (const p of this.pending.values()) {
        p.reject({ code: -32000, message: `daemon exited (${code ?? signal})` });
      }
      this.pending.clear();
      this.child = null;
    });
    // Ping to confirm the transport is alive before handing off.
    await this.call("ping");
    this.markReady();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.child = null;
  }

  async whenReady(): Promise<void> {
    return this.ready;
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, params: params ?? null };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      if (!this.child) {
        reject({ code: -32000, message: "daemon not running" });
        return;
      }
      this.child.stdin.write(JSON.stringify(frame) + "\n");
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg: {
        id?: number;
        result?: unknown;
        error?: { code: number; message: string };
      };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== "number") continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(msg.error);
      } else {
        p.resolve(msg.result);
      }
    }
  }
}

// Same resolution order as the extension: env override → bundled bin
// under extension/bin/ → ~/.ive/<version>/ → sibling target/release.
export function findDaemonBinary(userPath: string | undefined): string | null {
  if (userPath && fs.existsSync(userPath)) return userPath;
  const repoRoot = path.resolve(__dirname, "..", "..");
  const candidates = [
    path.join(repoRoot, "target", "release", "ive-daemon"),
    path.join(repoRoot, "target", "release", "ive-daemon.exe"),
    path.join(repoRoot, "extension", "bin", "ive-daemon"),
    path.join(repoRoot, "extension", "bin", "ive-daemon.exe"),
    path.join(repoRoot, "target", "debug", "ive-daemon"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
