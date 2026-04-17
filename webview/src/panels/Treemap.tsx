// Squarified treemap of the workspace, one rectangle per file. File colour
// is the health bucket; files with composite > 0.6 get an inline label.
//
// Clicking a file drills into a function-level treemap for that file —
// breadcrumb at the top navigates back up.

import { useMemo, useRef, useState, useEffect } from "react";
import type { HealthScore, Location } from "../types";
import { layout, scoresToLeaves, bucketColor, type Leaf, type Rect } from "./treemap";
import { vs } from "../vscode";

interface DrillView {
  kind: "file";
  file: string;
}

export function Treemap({ scores }: { scores: HealthScore[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<{ rect: Rect; x: number; y: number } | null>(null);
  const [drill, setDrill] = useState<DrillView | null>(null);

  // Attach ResizeObserver whenever the host div is present. We key on
  // `scores.length > 0` because early-return states below unmount the
  // ref-div, which would orphan a static `[]`-dep effect. Re-running
  // lets the observer fire after scores arrive.
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    // Prime synchronously so the first layout is non-zero even if
    // ResizeObserver hasn't fired yet. Playwright in headless chromium
    // occasionally defers the initial RO callback long enough that our
    // click tests would otherwise land on 0×0 tiles.
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

  if (scores.length === 0) {
    return <div className="empty">No supported files indexed yet.</div>;
  }

  return (
    <div className="treemap-wrap">
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
          {rects.map((r, i) => (
            <g
              key={i}
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
          ))}
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
