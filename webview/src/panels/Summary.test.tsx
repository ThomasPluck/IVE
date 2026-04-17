import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Summary } from "./Summary";
import type { GroundedSummary } from "../types-summary";

const baseSummary: GroundedSummary = {
  symbol: "handler.process_request",
  text: "header",
  factsGiven: [
    { id: "f1", kind: "call", content: "calls validate_payload" },
    { id: "f2", kind: "return_type", content: "returns JSONResponse" },
  ],
  claims: [
    {
      text: "Validates the request payload.",
      entailed: true,
      supportingFactIds: ["f1"],
    },
    {
      text: "Persists to Redis.",
      entailed: false,
      supportingFactIds: [],
      reason: "no supporting fact found",
    },
  ],
  model: "ive-offline",
  generatedAt: "2026-04-17T00:00:00Z",
};

describe("Summary panel", () => {
  it("renders a symbol header with the entailed ratio", () => {
    render(<Summary summary={baseSummary} capabilities={{}} />);
    expect(screen.getByText(/handler\.process_request/)).toBeDefined();
    expect(screen.getByText(/verified 1\/2/)).toBeDefined();
  });

  it("strikes through unentailed claims via the claim-bad class", () => {
    const { container } = render(<Summary summary={baseSummary} capabilities={{}} />);
    const bad = container.querySelectorAll(".claim-bad");
    expect(bad.length).toBe(1);
    expect(bad[0].textContent).toMatch(/Redis/);
  });

  it("shows the low-confidence banner when >30% of claims fail the gate", () => {
    const lowConf: GroundedSummary = {
      ...baseSummary,
      claims: [
        { text: "good claim.", entailed: true, supportingFactIds: ["f1"] },
        { text: "bad claim 1.", entailed: false, supportingFactIds: [] },
        { text: "bad claim 2.", entailed: false, supportingFactIds: [] },
      ],
    };
    const { container } = render(<Summary summary={lowConf} capabilities={{}} />);
    const banner = container.querySelector(".banner-warn");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toMatch(/low-confidence/);
  });

  it("empty state with a degraded LLM shows the reason", () => {
    render(
      <Summary
        summary={null}
        capabilities={{ llm: { available: false, reason: "ANTHROPIC_API_KEY not set" } }}
      />,
    );
    expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeDefined();
  });
});
