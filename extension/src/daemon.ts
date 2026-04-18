// Spawns and supervises the `ive-daemon` subprocess. Owns the JSON-RPC
// transport. Emits typed events to the rest of the extension.

import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { DaemonEvent, MethodName, MethodRequest, MethodResponse } from "./contracts";
import * as log from "./logger";

type Pending = { resolve: (value: unknown) => void; reject: (reason: { code: number; message: string }) => void };

export interface DaemonOptions {
  binaryPath: string;
  workspace: string;
  logLevel?: string;
}

export class Daemon extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private restarts = 0;
  private closed = false;

  constructor(private readonly opts: DaemonOptions) {
    super();
  }

  start(): void {
    if (this.child) return;
    log.info("spawning daemon", { bin: this.opts.binaryPath, workspace: this.opts.workspace });
    const env = { ...process.env };
    if (this.opts.logLevel) {
      env.RUST_LOG = `ive_daemon=${this.opts.logLevel}`;
    }
    const child = spawn(this.opts.binaryPath, ["--workspace", this.opts.workspace], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.onStderr(chunk));
    child.on("exit", (code, signal) => this.onExit(code, signal));
    child.on("error", (err) => {
      log.error("daemon process error", err.message);
      this.emit("error", err);
    });
  }

  async stop(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 1000);
    await new Promise<void>((resolve) => {
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
    this.child = null;
  }

  call<M extends MethodName>(method: M, params?: MethodRequest<M>): Promise<MethodResponse<M>> {
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, params: params ?? null };
    return new Promise<MethodResponse<M>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as MethodResponse<M>),
        reject,
      });
      const text = JSON.stringify(frame) + "\n";
      if (!this.child) {
        reject({ code: -32000, message: "daemon not running" });
        return;
      }
      this.child.stdin.write(text);
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      this.handleMessage(line);
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let idx: number;
    while ((idx = this.stderrBuffer.indexOf("\n")) >= 0) {
      const line = this.stderrBuffer.slice(0, idx).trimEnd();
      this.stderrBuffer = this.stderrBuffer.slice(idx + 1);
      if (line) log.info(`daemon: ${line}`);
    }
  }

  private handleMessage(line: string): void {
    let msg: {
      jsonrpc?: string;
      id?: number | string | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log.warn("daemon emitted non-JSON line", line);
      return;
    }
    if (msg.method === "daemon.event" && msg.params) {
      this.emit("event", msg.params as DaemonEvent);
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(msg.error);
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    log.warn("daemon exited", { code, signal, restarts: this.restarts });
    for (const p of this.pending.values()) {
      p.reject({ code: -32000, message: "daemon terminated" });
    }
    this.pending.clear();
    this.child = null;
    if (this.closed) return;
    if (this.restarts >= 3) {
      this.emit("fatal", new Error(`daemon keeps crashing (${this.restarts} restarts)`));
      return;
    }
    this.restarts += 1;
    const backoff = 500 * Math.pow(2, this.restarts - 1);
    setTimeout(() => {
      if (!this.closed) this.start();
    }, backoff);
  }
}

// Resolution order: ive.daemon.path setting → bundled binary → $PATH.
export function findDaemonBinary(extensionRoot: string, userSetting: string | undefined): string | null {
  if (userSetting && userSetting.length > 0 && fs.existsSync(userSetting)) {
    return userSetting;
  }
  const candidates = [
    path.join(extensionRoot, "bin", "ive-daemon"),
    path.join(extensionRoot, "bin", "ive-daemon.exe"),
    path.join(extensionRoot, "..", "target", "release", "ive-daemon"),
    path.join(extensionRoot, "..", "target", "release", "ive-daemon.exe"),
    path.join(extensionRoot, "..", "target", "debug", "ive-daemon"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
