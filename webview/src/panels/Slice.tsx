// Slice panel.
//
// v1 renders an intra-function slice (workstream C partial; backed by the
// daemon's tree-sitter-only slicer). Cross-file / full PDG slices still
// require the full CPG — we surface that as a degraded banner and keep
// the panel usable.

import type { Location } from "../types";
import { vs } from "../vscode";

export interface SliceNode {
  id: number;
  location: Location;
  label: string;
}

export interface SliceEdge {
  from: number;
  to: number;
  kind: "data" | "control" | "call";
}

export interface SliceView {
  nodes: SliceNode[];
  edges: SliceEdge[];
  truncated: boolean;
  elapsedMs: number;
  direction: "backward" | "forward";
}

export function Slice({
  slice,
  capabilities,
}: {
  slice: SliceView | null;
  capabilities: Record<string, { available: boolean; reason: string }>;
}) {
  const cpg = capabilities.cpg;
  const cpgDegraded = !cpg?.available;

  if (!slice) {
    return (
      <div className="slice-empty">
        <p>Right-click a variable in the editor → Slice → Backward or Forward.</p>
        {cpgDegraded ? (
          <p className="degraded">
            Cross-file slicing unavailable — CPG not built. {cpg?.reason ?? ""} Intra-function slicing still works.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="slice">
      <header className="slice-header">
        <span>
          Slice{" "}
          <span className="dim">
            {slice.direction} · {slice.nodes.length} nodes · {slice.elapsedMs}ms
          </span>
        </span>
        {slice.truncated ? (
          <span className="banner-inline">max hops reached — increase limit to see more</span>
        ) : null}
      </header>
      <ol className="slice-list">
        {slice.nodes.map((n, i) => (
          <li
            key={n.id}
            className="slice-row"
            tabIndex={0}
            onClick={() => vs().postMessage({ type: "openFile", location: n.location })}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                vs().postMessage({ type: "openFile", location: n.location });
            }}
          >
            <span className="slice-dot" aria-hidden="true">
              {i === 0 ? "●" : "○"}
            </span>
            <span className="slice-label">{n.label}</span>
            <span className="slice-loc dim">
              {n.location.file}:{n.location.range.start[0] + 1}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
