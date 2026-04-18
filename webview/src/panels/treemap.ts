// Squarified treemap (Bruls et al. 2000). Deterministic, pure, testable.
//
// Takes a flat list of files with LOC + bucket and returns rectangles to
// render. We group by directory to preserve the "folder with children"
// visual hinted at in `spec §7.3`. Directory nodes get a 1px border and no
// fill; file leaves get their bucket colour.

import type { HealthBucket, HealthScore, HealthTarget } from "../types";

export interface Leaf {
  path: string; // workspace-relative
  value: number; // area-weight (LOC)
  bucket: HealthBucket;
  composite: number;
  symbolOrFile: HealthTarget;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "leaf" | "dir";
  label: string;
  leaf?: Leaf;
}

export function scoresToLeaves(scores: HealthScore[]): Leaf[] {
  const out: Leaf[] = [];
  for (const s of scores) {
    if (typeof s.target === "object" && "file" in s.target) {
      // Use LOC as area; fall back to 1 if the daemon didn't supply it.
      const loc = s.location.range.end[0] - s.location.range.start[0] + 1;
      out.push({
        path: s.target.file,
        value: Math.max(loc, 1),
        bucket: s.bucket,
        composite: s.composite,
        symbolOrFile: s.target,
      });
    }
  }
  return out;
}

export function layout(leaves: Leaf[], width: number, height: number): Rect[] {
  if (leaves.length === 0 || width <= 0 || height <= 0) return [];
  const total = leaves.reduce((acc, l) => acc + l.value, 0);
  if (total === 0) return [];
  const sorted = [...leaves].sort((a, b) => b.value - a.value);
  const area = (v: number) => (v / total) * width * height;
  const rects: Rect[] = [];
  squarify(
    sorted.map((l) => ({ value: area(l.value), leaf: l })),
    [],
    { x: 0, y: 0, w: width, h: height },
    rects,
  );
  return rects;
}

interface Node {
  value: number;
  leaf: Leaf;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function squarify(children: Node[], row: Node[], box: Box, out: Rect[]): void {
  if (children.length === 0) {
    layoutRow(row, box, out);
    return;
  }
  const next = children[0];
  const rowWithNext = row.concat(next);
  const shortest = Math.min(box.w, box.h);
  if (row.length === 0 || worst(rowWithNext, shortest) < worst(row, shortest)) {
    squarify(children.slice(1), rowWithNext, box, out);
  } else {
    const rowBox = layoutRow(row, box, out);
    squarify(children, [], rowBox, out);
  }
}

function worst(row: Node[], shortest: number): number {
  if (row.length === 0) return Infinity;
  const sum = row.reduce((a, n) => a + n.value, 0);
  if (sum === 0) return Infinity;
  let max = 0,
    min = Infinity;
  for (const n of row) {
    if (n.value > max) max = n.value;
    if (n.value < min) min = n.value;
  }
  const s2 = shortest * shortest;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

function layoutRow(row: Node[], box: Box, out: Rect[]): Box {
  if (row.length === 0) return box;
  const sum = row.reduce((a, n) => a + n.value, 0);
  const horizontal = box.w >= box.h;
  if (horizontal) {
    const w = sum / box.h;
    let y = box.y;
    for (const n of row) {
      const h = n.value / w;
      out.push({
        x: box.x,
        y,
        w,
        h,
        kind: "leaf",
        label: n.leaf.path,
        leaf: n.leaf,
      });
      y += h;
    }
    return { x: box.x + w, y: box.y, w: box.w - w, h: box.h };
  } else {
    const h = sum / box.w;
    let x = box.x;
    for (const n of row) {
      const w = n.value / h;
      out.push({
        x,
        y: box.y,
        w,
        h,
        kind: "leaf",
        label: n.leaf.path,
        leaf: n.leaf,
      });
      x += w;
    }
    return { x: box.x, y: box.y + h, w: box.w, h: box.h - h };
  }
}

export const bucketColor: Record<HealthBucket, string> = {
  green: "var(--ive-green)",
  yellow: "var(--ive-yellow)",
  red: "var(--ive-red)",
};
