// Squarified treemap of the workspace, one rectangle per file. File colour
// is the health bucket; files with composite > 0.6 get an inline label.

import { useMemo, useRef, useState, useEffect } from "react";
import type { HealthScore, Location } from "../types";
import { layout, scoresToLeaves, bucketColor, type Rect } from "./treemap";
import { vs } from "../vscode";

export function Treemap({ scores }: { scores: HealthScore[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<{ rect: Rect; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setSize({ width: e.contentRect.width, height: e.contentRect.height });
      }
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const rects = useMemo(
    () => layout(scoresToLeaves(scores), Math.max(size.width, 1), Math.max(size.height, 1)),
    [scores, size],
  );

  if (scores.length === 0) {
    return <div className="empty">No supported files indexed yet.</div>;
  }

  return (
    <div ref={ref} className="treemap" role="img" aria-label="Workspace health treemap">
      <svg width={size.width} height={size.height}>
        {rects.map((r, i) => (
          <g
            key={i}
            onMouseEnter={(e) => setHover({ rect: r, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => setHover({ rect: r, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setHover(null)}
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
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 1) return "…";
  return "…" + s.slice(-Math.max(1, n - 1));
}

function openLeaf(rect: Rect): void {
  if (!rect.leaf) return;
  const loc: Location = {
    file: rect.leaf.path,
    range: { start: [0, 0], end: [0, 0] },
  };
  vs().postMessage({ type: "openFile", location: loc });
}
