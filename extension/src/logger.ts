import * as vscode from "vscode";

let channel: vscode.OutputChannel | null = null;

export function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("IVE");
  }
  return channel;
}

export function info(msg: string, data?: unknown): void {
  const suffix = data ? ` ${safeStringify(data)}` : "";
  getChannel().appendLine(`[info ] ${msg}${suffix}`);
}

export function warn(msg: string, data?: unknown): void {
  const suffix = data ? ` ${safeStringify(data)}` : "";
  getChannel().appendLine(`[warn ] ${msg}${suffix}`);
}

export function error(msg: string, data?: unknown): void {
  const suffix = data ? ` ${safeStringify(data)}` : "";
  getChannel().appendLine(`[error] ${msg}${suffix}`);
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
