// Diagnostics panel — grouped by severity, AI-specific sources surface first
// within each group. Keyboard navigable per spec §7.4:
//   j / ↓   move selection down
//   k / ↑   move selection up
//   Enter   jump to the diagnostic location
//   .       trigger a fix if one is available

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Diagnostic, DiagnosticSource, Severity } from "../types";
import { vs } from "../vscode";

const SEVERITY_ORDER: Severity[] = ["critical", "error", "warning", "info", "hint"];
const AI_SOURCES: DiagnosticSource[] = [
  "ive-hallucination",
  "ive-cwe",
  "ive-crossfile",
  "ive-binding",
];

const SEVERITY_ICON: Record<Severity, string> = {
  critical: "▲",
  error: "●",
  warning: "▲",
  info: "i",
  hint: "·",
};

export function Diagnostics({ diagnostics }: { diagnostics: Record<string, Diagnostic[]> }) {
  const flat = useMemo(() => {
    const arr: Diagnostic[] = [];
    for (const list of Object.values(diagnostics)) {
      for (const d of list) arr.push(d);
    }
    return arr;
  }, [diagnostics]);

  const [enabledSources, setEnabledSources] = useState<Set<DiagnosticSource>>(new Set());
  const [excludedSources, setExcludedSources] = useState<Set<DiagnosticSource>>(new Set());

  const filtered = useMemo(() => {
    return flat.filter((d) => {
      if (excludedSources.has(d.source)) return false;
      if (enabledSources.size > 0 && !enabledSources.has(d.source)) return false;
      return true;
    });
  }, [flat, enabledSources, excludedSources]);

  const grouped = useMemo(() => groupBySeverity(filtered), [filtered]);

  const ordered = useMemo<Diagnostic[]>(
    () => SEVERITY_ORDER.flatMap((sev) => grouped.get(sev) ?? []),
    [grouped],
  );

  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    if (cursor >= ordered.length) setCursor(Math.max(0, ordered.length - 1));
  }, [ordered, cursor]);

  const sourceCounts = useMemo(() => {
    const m = new Map<DiagnosticSource, number>();
    for (const d of flat) m.set(d.source, (m.get(d.source) ?? 0) + 1);
    return m;
  }, [flat]);

  const toggleSource = (s: DiagnosticSource, shift: boolean) => {
    if (shift) {
      setExcludedSources((prev) => {
        const n = new Set(prev);
        if (n.has(s)) n.delete(s);
        else n.add(s);
        return n;
      });
    } else {
      setEnabledSources((prev) => {
        const n = new Set(prev);
        if (n.has(s)) n.delete(s);
        else n.add(s);
        return n;
      });
    }
  };

  const containerRef = useRef<HTMLDivElement | null>(null);

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (ordered.length === 0) return;
      switch (e.key) {
        case "j":
        case "ArrowDown":
          setCursor((c) => Math.min(c + 1, ordered.length - 1));
          e.preventDefault();
          break;
        case "k":
        case "ArrowUp":
          setCursor((c) => Math.max(c - 1, 0));
          e.preventDefault();
          break;
        case "Enter":
          vs().postMessage({ type: "openFile", location: ordered[cursor].location });
          e.preventDefault();
          break;
        case ".":
          // Fix trigger is a daemon-side feature; when the diagnostic carries
          // a `fix`, the extension applies TextEdits. The webview asks the
          // extension to open the file and surface it as a quick-fix lightbulb.
          vs().postMessage({ type: "openFile", location: ordered[cursor].location });
          e.preventDefault();
          break;
      }
    },
    [ordered, cursor],
  );

  if (flat.length === 0) {
    return <div className="empty">✓ No diagnostics.</div>;
  }

  return (
    <div
      className="diagnostics"
      tabIndex={0}
      ref={containerRef}
      role="listbox"
      aria-activedescendant={ordered[cursor]?.id}
      onKeyDown={onKey}
    >
      <div className="filter-bar" role="group" aria-label="Diagnostic source filter">
        {[...sourceCounts.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([src, n]) => {
            const active = enabledSources.has(src);
            const excluded = excludedSources.has(src);
            return (
              <button
                key={src}
                className={`chip ${active ? "active" : ""} ${excluded ? "excluded" : ""}`}
                onClick={(e) => toggleSource(src, e.shiftKey)}
                title={excluded ? `${src}: excluded (shift-click to restore)` : src}
              >
                {src} <span className="chip-count">{n}</span>
              </button>
            );
          })}
      </div>
      {SEVERITY_ORDER.map((sev) => {
        const list = grouped.get(sev) ?? [];
        if (list.length === 0) return null;
        return (
          <section key={sev} className={`severity-group severity-${sev}`}>
            <header>
              <span className="sev-icon" aria-hidden="true">
                {SEVERITY_ICON[sev]}
              </span>
              {sev} <span className="dim">({list.length})</span>
            </header>
            <ul>
              {list.map((d) => {
                const index = ordered.indexOf(d);
                return (
                  <DiagnosticRow
                    key={d.id}
                    d={d}
                    selected={index === cursor}
                    onSelect={() => setCursor(index)}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function DiagnosticRow({
  d,
  selected,
  onSelect,
}: {
  d: Diagnostic;
  selected: boolean;
  onSelect: () => void;
}) {
  const onOpen = () => vs().postMessage({ type: "openFile", location: d.location });
  return (
    <li
      id={d.id}
      className={`diag severity-${d.severity} ${selected ? "selected" : ""}`}
      tabIndex={-1}
      role="option"
      aria-selected={selected}
      onClick={() => {
        onSelect();
        onOpen();
      }}
    >
      <div className="diag-top">
        <span className="diag-code">{d.code}</span>
        <span className="diag-message">{d.message}</span>
        <span className="diag-loc">
          {d.location.file}:{d.location.range.start[0] + 1}
        </span>
      </div>
      {d.fix ? <div className="diag-fix">↩ fix: {d.fix.description}</div> : null}
    </li>
  );
}

function groupBySeverity(ds: Diagnostic[]): Map<Severity, Diagnostic[]> {
  const m = new Map<Severity, Diagnostic[]>();
  for (const d of ds) {
    const arr = m.get(d.severity) ?? [];
    arr.push(d);
    m.set(d.severity, arr);
  }
  for (const [k, list] of m) {
    list.sort((a, b) => {
      const ai = AI_SOURCES.includes(a.source) ? 0 : 1;
      const bi = AI_SOURCES.includes(b.source) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      if (a.location.file !== b.location.file) return a.location.file.localeCompare(b.location.file);
      return a.location.range.start[0] - b.location.range.start[0];
    });
    m.set(k, list);
  }
  return m;
}
