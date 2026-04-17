import { describe, it, expect } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { App } from "./App";
import type { FromExtensionMessage, HealthScore } from "./types";

function dispatch(msg: FromExtensionMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  });
}

function mkFile(file: string, composite: number, bucket: HealthScore["bucket"]): HealthScore {
  return {
    target: { file },
    location: { file, range: { start: [0, 0], end: [50, 0] } },
    novelty: { value: 0, daysSinceCreated: 0, recentChurnLoc: 0 },
    cognitiveComplexity: { value: 0, raw: 0 },
    coupling: { value: 0, fanIn: 0, fanOut: 0 },
    aiSignal: { value: 0, diagnosticCount: 0, hallucinatedImports: 0, untestedBlastRadius: 0 },
    composite,
    bucket,
  };
}

describe("IVE App", () => {
  it("transitions phase on status + workspaceState messages", async () => {
    render(<App />);
    expect(screen.getByText(/cold/i)).toBeTruthy();

    dispatch({ type: "status", payload: { phase: "indexing" } });
    await screen.findByText(/indexing/i);

    dispatch({
      type: "workspaceState",
      payload: {
        scores: [mkFile("a.py", 0.8, "red"), mkFile("b.py", 0.1, "green")],
        diagnostics: {
          "a.py": [
            {
              id: "x",
              severity: "critical",
              source: "ive-hallucination",
              code: "ive-hallucination/unknown-import",
              message: "no package 'foo'",
              location: { file: "a.py", range: { start: [0, 0], end: [0, 0] } },
            },
          ],
        },
        capabilities: { cpg: { available: false, reason: "joern not installed" } },
      },
    });
    await screen.findByText(/ready/i);
    await screen.findByText(/Degraded: cpg/);
    await screen.findByText("[1]");
  });

  it("surfaces a degraded banner on capabilityDegraded events", async () => {
    render(<App />);
    dispatch({
      type: "event",
      payload: { type: "capabilityDegraded", capability: "semgrep", reason: "not on PATH" },
    });
    await screen.findByText(/Degraded: semgrep/);
  });

  it("renders per-panel errors for summary and slice, not a global banner", async () => {
    const { container } = render(<App />);
    // Bring the view into "ready" state so the panels show.
    dispatch({
      type: "workspaceState",
      payload: { scores: [mkFile("a.py", 0.1, "green")], diagnostics: {}, capabilities: {} },
    });

    dispatch({ type: "rpcError", id: -1, error: { code: -32000, message: "no API key" } });
    await screen.findAllByText(/Summary failed: no API key/);
    // The global banner must NOT fire for a panel-scoped error.
    expect(container.querySelector(".banner-error")).toBeNull();

    dispatch({ type: "rpcError", id: -2, error: { code: -32000, message: "no CPG" } });
    await screen.findAllByText(/Slice failed: no CPG/);
  });
});
