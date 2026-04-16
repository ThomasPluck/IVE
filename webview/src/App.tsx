import { useEffect, useState } from "react";
import type { DaemonEvent, FromExtensionMessage, WorkspaceState } from "./types";
import { Treemap } from "./panels/Treemap";
import { Diagnostics } from "./panels/Diagnostics";
import { Summary } from "./panels/Summary";
import { Slice } from "./panels/Slice";
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const msg = ev.data as FromExtensionMessage;
      switch (msg.type) {
        case "status":
          setPhase(msg.payload.phase);
          if (msg.payload.phase === "error") {
            setErrorMessage(msg.payload.message ?? "unknown error");
          } else {
            setErrorMessage(null);
          }
          break;
        case "event":
          applyEvent(msg.payload);
          break;
        case "workspaceState":
          setState(msg.payload);
          setPhase("ready");
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
    }
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
      </header>

      {errorMessage ? <div className="banner banner-error">Error: {errorMessage}</div> : null}
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
          <Treemap scores={state.scores} />
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
        <header>Summary</header>
        <div className="panel-body">
          <Summary summary={null} capabilities={state.capabilities} />
        </div>
      </section>

      <section className="panel panel-slice" aria-label="Slice">
        <header>Slice</header>
        <div className="panel-body">
          <Slice capabilities={state.capabilities} />
        </div>
      </section>
    </div>
  );
}
