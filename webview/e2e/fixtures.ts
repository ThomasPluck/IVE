// Playwright fixtures for driving the built webview the same way the
// VSCode extension host does.
//
// The webview talks to the host through two channels:
//   1. `acquireVsCodeApi()` — the webview calls `postMessage(...)` on the
//      returned handle to send outgoing messages (openFile, summarize,
//      sliceRequested, applyFix).
//   2. `window.message` events — the host dispatches
//      FromExtensionMessage envelopes.
//
// Before the app's bundle evaluates we inject a tiny shim that captures
// outgoing postMessages into `window.__iveOutgoing` so tests can assert
// on them, and dispatches incoming messages via
// `window.__iveDeliver(msg)`.

import { test as base, expect, type Page } from "@playwright/test";

const SHIM = `
  window.__iveOutgoing = [];
  window.acquireVsCodeApi = function() {
    return {
      postMessage: (m) => { window.__iveOutgoing.push(m); },
      getState: () => undefined,
      setState: () => undefined,
    };
  };
  window.__iveDeliver = function(msg) {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  };
`;

export const test = base.extend<{ view: WebviewHarness }>({
  view: async ({ page }, use) => {
    // Inject the shim before any script on the page runs.
    await page.addInitScript({ content: SHIM });
    await page.goto("/");
    const harness = new WebviewHarness(page);
    // Wait for the react app to mount.
    await expect(page.locator(".app-header")).toBeVisible();
    // Most tests want the ready state, so synthesise a minimal
    // workspaceState. Individual tests that need a different starting
    // point can call `harness.dispatchWorkspaceState(...)` themselves.
    await harness.dispatchWorkspaceState(defaultWorkspaceState());
    await use(harness);
  },
});

export { expect } from "@playwright/test";

export class WebviewHarness {
  constructor(readonly page: Page) {}

  async dispatch(msg: unknown): Promise<void> {
    await this.page.evaluate((m) => (window as any).__iveDeliver(m), msg);
  }

  async dispatchWorkspaceState(payload: unknown): Promise<void> {
    await this.dispatch({ type: "workspaceState", payload });
    // React processes the message asynchronously (setState batch, then
    // reconcile). Block until the app is in the `ready` phase so tests
    // don't race the render cycle.
    await this.page.locator(".phase-ready").waitFor({ state: "visible", timeout: 5000 });
  }

  async outgoing(): Promise<unknown[]> {
    return this.page.evaluate(() => (window as any).__iveOutgoing);
  }

  async clearOutgoing(): Promise<void> {
    await this.page.evaluate(() => {
      (window as any).__iveOutgoing = [];
    });
  }
}

export function defaultWorkspaceState() {
  return {
    scores: [
      fileScore("services/slop.py", 35, "red", 0.82, {
        hallucinatedImports: 1,
        diagnosticCount: 2,
      }),
      fileScore("services/clean.py", 20, "green", 0.08),
      symbolScore("services/slop.py", "slop.fetch", [5, 0], [30, 0], "red", 0.74),
    ],
    diagnostics: {
      "services/slop.py": [
        {
          id: "hallucination:services/slop.py:2:huggingface_utils",
          severity: "critical",
          source: "ive-hallucination",
          code: "ive-hallucination/unknown-import",
          message: "no package 'huggingface_utils' in requirements.txt",
          location: {
            file: "services/slop.py",
            range: { start: [2, 0], end: [2, 24] },
          },
          fix: {
            description: "Delete `import huggingface_utils`",
            edits: [
              {
                location: {
                  file: "services/slop.py",
                  range: { start: [2, 0], end: [3, 0] },
                },
                newText: "",
              },
            ],
          },
        },
        {
          id: "tsc-ish-1",
          severity: "error",
          source: "pyright",
          code: "reportUnknownMember",
          message: "unknown member 'flurb'",
          location: {
            file: "services/slop.py",
            range: { start: [12, 4], end: [12, 9] },
          },
        },
      ],
    },
    capabilities: {
      cpg: { available: false, reason: "Joern not installed" },
      pyright: { available: true, reason: "ready" },
      llm: { available: false, reason: "ANTHROPIC_API_KEY not set" },
    },
  };
}

function fileScore(
  file: string,
  loc: number,
  bucket: "green" | "yellow" | "red",
  composite: number,
  aiExtras: Partial<{ hallucinatedImports: number; diagnosticCount: number }> = {},
) {
  return {
    target: { file },
    location: { file, range: { start: [0, 0], end: [loc - 1, 0] } },
    novelty: { value: 0, daysSinceCreated: 0, recentChurnLoc: 0 },
    cognitiveComplexity: { value: 0.4, raw: 12 },
    coupling: { value: 0.2, fanIn: 2, fanOut: 5 },
    aiSignal: {
      value: 0.5,
      diagnosticCount: aiExtras.diagnosticCount ?? 0,
      hallucinatedImports: aiExtras.hallucinatedImports ?? 0,
      untestedBlastRadius: 0,
    },
    composite,
    bucket,
  };
}

function symbolScore(
  file: string,
  symbol: string,
  start: [number, number],
  end: [number, number],
  bucket: "green" | "yellow" | "red",
  composite: number,
) {
  return {
    target: `local . ive ${file} ${symbol}#.`,
    location: { file, range: { start, end } },
    novelty: { value: 0, daysSinceCreated: 0, recentChurnLoc: 0 },
    cognitiveComplexity: { value: 0.5, raw: 15 },
    coupling: { value: 0.3, fanIn: 1, fanOut: 8 },
    aiSignal: {
      value: 0.6,
      diagnosticCount: 1,
      hallucinatedImports: 1,
      untestedBlastRadius: 0,
    },
    composite,
    bucket,
  };
}
