import { describe, it, expect } from "vitest";
import { heuristicTitle } from "./scheduler.js";

describe("heuristicTitle", () => {
  it("returns the first sentence of the goal", () => {
    expect(heuristicTitle("Fix the login bug. Then add a test.")).toBe("Fix the login bug");
  });

  it("strips polite prefixes", () => {
    expect(heuristicTitle("please fix the login bug")).toBe("fix the login bug");
    expect(heuristicTitle("Can you refactor payments?")).toBe("refactor payments");
    expect(heuristicTitle("I want to add logging")).toBe("add logging");
  });

  it("clips to 60 chars with an ellipsis", () => {
    const long = "a".repeat(80);
    const out = heuristicTitle(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(heuristicTitle("  fix    the  bug  ")).toBe("fix the bug");
  });

  it("falls back on empty input", () => {
    expect(heuristicTitle("")).toBe("(untitled)");
    expect(heuristicTitle("   ")).toBe("(untitled)");
  });
});
