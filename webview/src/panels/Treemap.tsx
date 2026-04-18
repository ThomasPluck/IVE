// Squarified treemap of the workspace.
//
// Two visual primitives live here beyond the health colour:
//
// 1. **Spotlight** — tiles whose file is mentioned by an active note
//    get a pulsing coloured ring. The ring colour is the note's kind
//    (observation=blue, intent=magenta, question=yellow, concern=red
//    or yellow depending on severity). This is how Claude "points" at
//    a file without opening a modal — the user sees the glow on the
//    tile they know.
// 2. **Focus** — when the user clicks a note, the app passes
//    `focusFile` here. Every tile that *isn't* the focused file is
//    dimmed so the topology collapses around Claude's concern. Esc or
//    clicking the breadcrumb resets.
//
// Clicking a file drills into a function-level treemap for that file —
// breadcrumb at the top navigates back up.

import { useMemo, useRef, useState, useEffect } from "react";
import type { HealthScore, Location, NoteKind, Severity } from "../types";
import { layout, scoresToLeaves, bucketColor, type Leaf, type Rect } from "./treemap";
import { vs } from "../vscode";

interface DrillView {
  kind: "file";
  file: string;
}

export interface SpotlightEntry {
  file: string;
  kind: NoteKind;
  severity?: Severity;
}

const SPOTLIGHT_STROKE: Record<NoteKind, string> = {
  observation: "var(--ive-blue)",
  intent: "var(--ive-magenta)",
  question: "var(--ive-yellow)",
  concern: "var(--ive-yellow)",
};

const SEVERITY_STROKE: Partial<Record<Severity, string>> = {
  critical: "var(--ive-red)",
  error: "var(--ive-red)",
  warning: "var(--ive-yellow)",
};

function spotlightColor(entry: SpotlightEntry): string {
  if (entry.severity) {
    const c = SEVERITY_STROKE[entry.severity];
    if (c) return c;
  }
  return SPOTLIGHT_STROKE[entry.kind];
}

export function Treemap({
  scores,
  spotlights = [],
  focusFile = null,
}: {
  scores: HealthScore[];
  spotlights?: SpotlightEntry[];
  focusFile?: string | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<{ rect: Rect; x: number; y: number } | null>(null);
  const [drill, setDrill] = useState<DrillView | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setSize({ width: rect.width, height: rect.height });
    }
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setSize({ width: e.contentRect.width, height: e.contentRect.height });
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [scores.length > 0]);

  const activeScores = useMemo(() => {
    if (drill?.kind === "file") {
      return scores.filter(
        (s) => typeof s.target === "string" && s.location.file === drill.file,
      );
    }
    return scores.filter((s) => typeof s.target === "object");
  }, [scores, drill]);

  const rects = useMemo(() => {
    const leaves =
      drill?.kind === "file" ? symbolsToLeaves(activeScores) : scoresToLeaves(activeScores);
    return layout(leaves, Math.max(size.width, 1), Math.max(size.height - 24, 1));
  }, [activeScores, size, drill]);

  // Lookup: file → strongest spotlight colour (concern > question > intent > observation).
  const spotlightByFile = useMemo(() => {
    const priority: Record<NoteKind, number> = {
      concern: 3,
      question: 2,
      intent: 1,
      observation: 0,
    };
    const best = new Map<string, SpotlightEntry>();
    for (const s of spotlights) {
      const cur = best.get(s.file);
      if (!cur || priority[s.kind] > priority[cur.kind]) best.set(s.file, s);
    }
    return best;
  }, [spotlights]);

  if (scores.length === 0) {
    return <div className="empty">No supported files indexed yet.</div>;
  }

  return (
    <div className="treemap-wrap" data-focus={focusFile ?? undefined}>
      <nav className="breadcrumb" aria-label="Treemap breadcrumb">
        <button className="crumb" onClick={() => setDrill(null)}>
          workspace
        </button>
        {drill?.kind === "file" ? (
          <>
            <span className="crumb-sep">›</span>
            <span className="crumb active">{drill.file}</span>
          </>
        ) : null}
      </nav>
      <div ref={ref} className="treemap" role="img" aria-label="Workspace health treemap">
        <svg width={size.width} height={Math.max(size.height - 24, 0)}>
          {rects.map((r, i) => {
            const file = r.leaf ? leafFile(r.leaf) : null;
            const spot = file ? spotlightByFile.get(file) : undefined;
            const dimmed = focusFile != null && file !== focusFile;
            return (
              <g
                key={i}
                className={[
                  spot ? "tile-spotlit" : "",
                  dimmed ? "tile-dimmed" : "",
                  focusFile && file === focusFile ? "tile-focused" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={(e) => setHover({ rect: r, x: e.clientX, y: e.clientY })}
                onMouseMove={(e) => setHover({ rect: r, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHover(null)}
                onClick={() => onClick(r, drill, setDrill)}
                onDoubleClick={() => openLeaf(r)}
              >
                <rect
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fill={r.leaf ? bucketColor[r.leaf.bucket] : "transparent"}
                  stroke="var(--ive-border)"
                  strokeWidth={1}
                  fillOpacity={0.85}
                  style={{ cursor: "pointer" }}
                />
                {spot ? (
                  // Pulsing ring, inset 2px so it doesn't spill into the
                  // neighbour. CSS animates `stroke-opacity` on the
                  // `.spotlight-ring` class.
                  <rect
                    className="spotlight-ring"
                    x={r.x + 2}
                    y={r.y + 2}
                    width={Math.max(r.w - 4, 0)}
                    height={Math.max(r.h - 4, 0)}
                    fill="none"
                    stroke={spotlightColor(spot)}
                    strokeWidth={3}
                    pointerEvents="none"
                  />
                ) : null}
                {r.leaf && r.leaf.composite > 0.6 && r.w > 72 && r.h > 18 ? (
                  <text
                    x={r.x + 6}
                    y={r.y + 14}
                    fill="var(--ive-bg)"
                    fontSize={11}
                    fontWeight={600}
                    pointerEvents="none"
                  >
                    {truncate(r.leaf.path, Math.floor(r.w / 7))}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {hover && hover.rect.leaf ? (
          <div
            className="tooltip"
            style={{ left: hover.x + 8, top: hover.y + 8 }}
            role="tooltip"
          >
            <strong>{hover.rect.leaf.path}</strong>
            <br />
            {hover.rect.leaf.value} LOC · health {hover.rect.leaf.composite.toFixed(2)} ·{" "}
            <span className={`bucket-${hover.rect.leaf.bucket}`}>{hover.rect.leaf.bucket}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function leafFile(leaf: Leaf): string | null {
  const t = leaf.symbolOrFile;
  if (typeof t === "object" && t && "file" in t) return t.file;
  return null;
}

function symbolsToLeaves(scores: HealthScore[]): Leaf[] {
  return scores
    .filter((s) => typeof s.target === "string")
    .map((s) => {
      const loc = s.location.range.end[0] - s.location.range.start[0] + 1;
      return {
        path: (s.target as string)
          .split(" ")
          .pop()!
          .replace(/#\.$/, ""),
        value: Math.max(loc, 1),
        bucket: s.bucket,
        composite: s.composite,
        symbolOrFile: s.target,
      } as Leaf;
    });
}

function onClick(
  r: Rect,
  drill: DrillView | null,
  setDrill: (d: DrillView | null) => void,
): void {
  if (!r.leaf) return;
  if (drill?.kind === "file") {
    openLeaf(r);
    return;
  }
  if (typeof r.leaf.symbolOrFile === "object" && "file" in r.leaf.symbolOrFile) {
    setDrill({ kind: "file", file: r.leaf.symbolOrFile.file });
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 1) return "…";
  return "…" + s.slice(-Math.max(1, n - 1));
}

function openLeaf(rect: Rect): void {
  if (!rect.leaf) return;
  const target = rect.leaf.symbolOrFile;
  let file = rect.leaf.path;
  if (typeof target === "object" && "file" in target) {
    file = target.file;
  }
  const loc: Location = {
    file,
    range: { start: [0, 0], end: [0, 0] },
  };
  vs().postMessage({ type: "openFile", location: loc });
}
