import { useEffect, useMemo, useState } from "react";
import type { DaemonEvent, FromExtensionMessage, Note, WorkspaceState } from "./types";
import type { GroundedSummary } from "./types-summary";
import { Treemap, type SpotlightEntry } from "./panels/Treemap";
import { Diagnostics } from "./panels/Diagnostics";
import { Summary } from "./panels/Summary";
import { Slice, type SliceView } from "./panels/Slice";
import { Vibe } from "./panels/Vibe";
import { vs } from "./vscode";

type Phase = "cold" | "indexing" | "ready" | "error";

export function App() {
  const [phase, setPhase] = useState<Phase>("cold");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [state, setState] = useState<WorkspaceState>({
    scores: [],
    diagnostics: {},
    capabilities: {},
  });
  const [summary, setSummary] = useState<GroundedSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [slice, setSlice] = useState<SliceView | null>(null);
  const [sliceError, setSliceError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  /// The file the user has clicked into via a Vibe note; null = no focus.
  /// When set, the treemap dims every other tile so the concern pops out
  /// of the topology.
  const [focusFile, setFocusFile] = useState<string | null>(null);
  /// Last time we saw a Claude-authored note arrive, expressed as a
  /// wall-clock Date.now(). Powers the header presence indicator.
  const [lastAgentActivityAt, setLastAgentActivityAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const msg = ev.data as FromExtensionMessage;
      switch (msg.type) {
        case "status":
          setPhase(msg.payload.phase);
          if (msg.payload.phase === "error") {
            setGlobalError(msg.payload.message ?? "unknown error");
          } else {
            setGlobalError(null);
          }
          break;
        case "event":
          applyEvent(msg.payload);
          break;
        case "workspaceState":
          setState(msg.payload);
          setPhase("ready");
          break;
        case "rpcResult":
          // Summary rides on id -1, slice on id -2 (see panel.ts).
          if (msg.id === -1 && isSummaryShape(msg.result)) {
            setSummary(msg.result as GroundedSummary);
            setSummaryLoading(false);
            setSummaryError(null);
          } else if (msg.id === -2 && isSliceShape(msg.result)) {
            setSlice(toSliceView(msg.result as SliceResultShape));
            setSliceError(null);
          }
          break;
        case "rpcError":
          // Per-panel errors (spec §7.9 state 6) — surfaced inline in the
          // affected panel rather than as a global banner so one failing
          // subsystem doesn't shout over everything else.
          if (msg.id === -1) {
            setSummaryLoading(false);
            setSummaryError(msg.error.message);
          } else if (msg.id === -2) {
            setSlice(null);
            setSliceError(msg.error.message);
          } else {
            setGlobalError(msg.error.message);
          }
          break;
      }
    };
    window.addEventListener("message", onMessage);
    vs().postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function applyEvent(e: DaemonEvent) {
    switch (e.type) {
      case "indexProgress":
        setProgress({ done: e.filesDone, total: e.filesTotal });
        if (e.filesTotal > 0 && e.filesDone < e.filesTotal) setPhase("indexing");
        break;
      case "healthUpdated":
        setState((s) => ({ ...s, scores: e.scores }));
        break;
      case "diagnosticsUpdated":
        setState((s) => ({
          ...s,
          diagnostics: { ...s.diagnostics, [e.file]: e.diagnostics },
        }));
        break;
      case "capabilityDegraded":
        setState((s) => ({
          ...s,
          capabilities: {
            ...s.capabilities,
            [e.capability]: { available: false, reason: e.reason },
          },
        }));
        break;
      case "capabilityRestored":
        setState((s) => ({
          ...s,
          capabilities: {
            ...s.capabilities,
            [e.capability]: { available: true, reason: "restored" },
          },
        }));
        break;
      case "notesUpdated":
        setState((s) => ({ ...s, notes: e.notes }));
        if (e.notes.some((n) => n.author === "claude")) {
          setLastAgentActivityAt(Date.now());
        }
        break;
    }
  }

  // Tick the clock at 1Hz so the "active Ns ago" label stays fresh
  // without firing on every React render.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Derive spotlights from notes with a location.
  const spotlights: SpotlightEntry[] = useMemo(() => {
    return (state.notes ?? [])
      .filter((n): n is Note & { location: { file: string } } => Boolean(n.location))
      .map((n) => ({ file: n.location.file, kind: n.kind, severity: n.severity }));
  }, [state.notes]);

  // Allow the Vibe panel to focus the treemap on a file when the user
  // clicks a note. Clicking a note anywhere calls this back via a
  // window-level event the Vibe component dispatches.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ file: string | null }>).detail;
      setFocusFile(detail?.file ?? null);
    };
    window.addEventListener("ive:focus-file", handler as EventListener);
    return () => window.removeEventListener("ive:focus-file", handler as EventListener);
  }, []);

  function requestSummaryForWorstFunction() {
    // Pick the highest-composite function-level score and summarize it.
    const fnScores = state.scores.filter((s) => typeof s.target === "string");
    const worst = [...fnScores].sort((a, b) => b.composite - a.composite)[0];
    if (!worst || typeof worst.target !== "string") {
      return;
    }
    setSummaryLoading(true);
    vs().postMessage({ type: "summarize", symbol: worst.target });
  }

  const diagnosticCount = Object.values(state.diagnostics).reduce((a, d) => a + d.length, 0);
  const anyDegraded = Object.values(state.capabilities).some((c) => !c.available);
  const degradedList = Object.entries(state.capabilities).filter(([, c]) => !c.available);

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">IVE</span>
        <span className={`phase phase-${phase}`}>{phase}</span>
        {phase === "indexing" && progress ? (
          <progress value={progress.done} max={Math.max(progress.total, 1)} />
        ) : null}
        <AgentPresence lastAt={lastAgentActivityAt} now={now} />
      </header>

      {globalError ? <div className="banner banner-error">Error: {globalError}</div> : null}
      {anyDegraded ? (
        <div className="banner banner-warn">
          Degraded: {degradedList.map(([k]) => k).join(", ")} — some features disabled.
        </div>
      ) : null}

      <section className="panel panel-treemap" aria-label="Treemap">
        <header>
          Treemap{" "}
          {state.scores.length > 0 ? <span className="dim">({state.scores.length} files)</span> : null}
        </header>
        <div className="panel-body">
          <Treemap
            scores={state.scores}
            spotlights={spotlights}
            focusFile={focusFile}
          />
          {focusFile ? (
            <button className="focus-reset" onClick={() => setFocusFile(null)}>
              clear focus · {focusFile}
            </button>
          ) : null}
        </div>
      </section>

      <section className="panel panel-diagnostics" aria-label="Diagnostics">
        <header>
          Diagnostics <span className="dim">[{diagnosticCount}]</span>
        </header>
        <div className="panel-body">
          <Diagnostics diagnostics={state.diagnostics} />
        </div>
      </section>

      <section className="panel panel-summary" aria-label="Summary">
        <header>
          Summary
          <button
            className="summary-action"
            onClick={requestSummaryForWorstFunction}
            disabled={summaryLoading || state.scores.length === 0}
          >
            {summaryLoading ? "…" : summary ? "regenerate (worst function)" : "summarize worst"}
          </button>
        </header>
        <div className="panel-body">
          {summaryError ? (
            <div className="panel-error">
              Summary failed: {summaryError}
              <button
                className="panel-error-dismiss"
                onClick={() => setSummaryError(null)}
              >
                dismiss
              </button>
            </div>
          ) : null}
          <Summary summary={summary} capabilities={state.capabilities} />
        </div>
      </section>

      <section className="panel panel-slice" aria-label="Slice">
        <header>Slice</header>
        <div className="panel-body">
          {sliceError ? (
            <div className="panel-error">
              Slice failed: {sliceError}
              <button
                className="panel-error-dismiss"
                onClick={() => setSliceError(null)}
              >
                dismiss
              </button>
            </div>
          ) : null}
          <Slice slice={slice} capabilities={state.capabilities} />
        </div>
      </section>

      <section className="panel panel-vibe" aria-label="Vibe feed">
        <header>
          Vibe{" "}
          {state.notes && state.notes.length > 0 ? (
            <span className="dim">[{state.notes.length}]</span>
          ) : null}
        </header>
        <div className="panel-body">
          <Vibe notes={state.notes ?? []} />
        </div>
      </section>
    </div>
  );
}

type SliceResultShape = {
  request: { direction: "backward" | "forward" };
  nodes: SliceView["nodes"];
  edges: SliceView["edges"];
  truncated: boolean;
  elapsedMs: number;
};

function isSliceShape(v: unknown): v is SliceResultShape {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.nodes) && Array.isArray(o.edges) && typeof o.truncated === "boolean";
}

function toSliceView(r: SliceResultShape): SliceView {
  return {
    nodes: r.nodes,
    edges: r.edges,
    truncated: r.truncated,
    elapsedMs: r.elapsedMs,
    direction: r.request?.direction ?? "backward",
  };
}

function isSummaryShape(v: unknown): v is GroundedSummary {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.symbol === "string" &&
    typeof o.text === "string" &&
    Array.isArray(o.claims) &&
    Array.isArray(o.factsGiven)
  );
}

// Presence indicator — a small pulsing dot + relative-time label that
// tells the user whether the agent is currently paying attention.
// Three states:
//   - never seen: hidden (keeps the chrome calm when no agent is wired)
//   - ≤3s ago:    live (green, pulsing)
//   - ≤60s ago:   recent (dim green, steady)
//   - >60s ago:   idle (grey, "idle 5m")
function AgentPresence({
  lastAt,
  now,
}: {
  lastAt: number | null;
  now: number;
}) {
  if (lastAt == null) return null;
  const delta = Math.max(0, now - lastAt);
  const label = relativeLabel(delta);
  let state: "live" | "recent" | "idle" = "idle";
  if (delta < 3000) state = "live";
  else if (delta < 60_000) state = "recent";
  return (
    <span
      className={`agent-presence agent-${state}`}
      title={`Last agent activity: ${label}`}
      aria-live="polite"
    >
      <span className="agent-dot" aria-hidden="true" />
      claude · {label}
    </span>
  );
}

function relativeLabel(delta: number): string {
  if (delta < 1500) return "active now";
  if (delta < 60_000) return `active ${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `idle ${Math.round(delta / 60_000)}m`;
  return `idle ${Math.round(delta / 3_600_000)}h`;
}
