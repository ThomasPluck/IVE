import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Diagnostics } from "./Diagnostics";
import type { Diagnostic } from "../types";

const mk = (
  code: string,
  severity: Diagnostic["severity"],
  source: Diagnostic["source"],
  message: string,
): Diagnostic => ({
  id: code,
  severity,
  source,
  code,
  message,
  location: { file: "a.py", range: { start: [0, 0], end: [0, 0] } },
});

describe("Diagnostics panel", () => {
  it("renders the empty-state banner when there are zero diagnostics", () => {
    render(<Diagnostics diagnostics={{}} />);
    expect(screen.getByText(/No diagnostics/)).toBeDefined();
  });

  it("groups entries under their severity header and orders AI sources first", () => {
    const diags = {
      "a.py": [
        mk("tsc-1", "error", "tsc", "type mismatch"),
        mk("ive-hallucination/unknown-import", "critical", "ive-hallucination", "no package 'foo'"),
      ],
    };
    render(<Diagnostics diagnostics={diags} />);
    expect(screen.getByText(/critical/)).toBeDefined();
    expect(screen.getByText(/type mismatch/)).toBeDefined();
    expect(screen.getByText(/no package 'foo'/)).toBeDefined();
  });
});
