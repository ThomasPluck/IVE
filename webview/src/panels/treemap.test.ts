import { describe, it, expect } from "vitest";
import { layout, scoresToLeaves } from "./treemap";
import type { HealthScore } from "../types";

const mkScore = (file: string, loc: number, bucket: "green" | "yellow" | "red"): HealthScore => ({
  target: { file },
  location: { file, range: { start: [0, 0], end: [loc - 1, 0] } },
  novelty: { value: 0, daysSinceCreated: 0, recentChurnLoc: 0 },
  cognitiveComplexity: { value: 0, raw: 0 },
  coupling: { value: 0, fanIn: 0, fanOut: 0 },
  aiSignal: { value: 0, diagnosticCount: 0, hallucinatedImports: 0, untestedBlastRadius: 0 },
  composite: bucket === "red" ? 0.7 : bucket === "yellow" ? 0.4 : 0.1,
  bucket,
});

describe("treemap layout", () => {
  it("tiles a set of rectangles with no overlap and no gaps", () => {
    const scores = [
      mkScore("a.py", 100, "red"),
      mkScore("b.py", 50, "yellow"),
      mkScore("c.py", 25, "green"),
      mkScore("d.py", 12, "green"),
    ];
    const leaves = scoresToLeaves(scores);
    const rects = layout(leaves, 800, 600);
    expect(rects).toHaveLength(4);
    // Areas should sum to roughly the bounding box area.
    const totalArea = rects.reduce((acc, r) => acc + r.w * r.h, 0);
    expect(totalArea).toBeGreaterThan(800 * 600 * 0.999);
    expect(totalArea).toBeLessThan(800 * 600 * 1.001);
    // No rectangle should escape the bounding box.
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(800 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(600 + 1e-6);
    }
  });

  it("empty input produces no rects", () => {
    expect(layout([], 100, 100)).toEqual([]);
    expect(layout(scoresToLeaves([mkScore("a.py", 5, "green")]), 0, 100)).toEqual([]);
  });

  it("leaves carry their bucket for colouring", () => {
    const rects = layout(scoresToLeaves([mkScore("a.py", 10, "red")]), 200, 100);
    expect(rects[0].leaf?.bucket).toBe("red");
  });
});
