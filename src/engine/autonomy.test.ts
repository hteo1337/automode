import { describe, it, expect } from "vitest";
import { policyFor, parseAutonomyLevel, isAutonomyLevel, isSuperYolo } from "./autonomy.js";

describe("autonomy policies", () => {
  it("strict never auto-approves", () => {
    const p = policyFor("strict");
    expect(p.autoApprovePlan).toBe(false);
    expect(p.autoApproveLowConfidence).toBe(false);
  });

  it("normal is the default (same as strict re: approval but more patient on failures)", () => {
    const p = policyFor("normal");
    expect(p.autoApprovePlan).toBe(false);
    expect(p.failureStreakToEscalate).toBe(3);
  });

  it("high auto-approves plan-first but keeps the tool-denial boundary", () => {
    const p = policyFor("high");
    expect(p.autoApprovePlan).toBe(true);
    expect(p.autoApproveLowConfidence).toBe(true);
    expect(p.escalateOnDeniedTool).toBe(true);
  });

  it("yolo auto-approves everything, still escalates on denied tool", () => {
    const p = policyFor("yolo");
    expect(p.autoApprovePlan).toBe(true);
    expect(p.autoApproveLowConfidence).toBe(true);
    expect(p.escalateOnDeniedTool).toBe(true);
    expect(p.failureStreakToEscalate).toBeGreaterThan(policyFor("high").failureStreakToEscalate);
  });

  it("super-yolo disables all tool guards", () => {
    const p = policyFor("super-yolo");
    expect(p.autoApprovePlan).toBe(true);
    expect(p.autoApproveLowConfidence).toBe(true);
    expect(p.escalateOnDeniedTool).toBe(false);
    expect(p.disableToolGuards).toBe(true);
    expect(p.failureStreakToEscalate).toBeGreaterThan(policyFor("yolo").failureStreakToEscalate);
  });

  it("no level other than super-yolo disables tool guards", () => {
    for (const l of ["strict", "normal", "high", "yolo"] as const) {
      expect(policyFor(l).disableToolGuards).toBe(false);
      expect(policyFor(l).escalateOnDeniedTool).toBe(true);
    }
  });
});

describe("parseAutonomyLevel", () => {
  it("accepts canonical names", () => {
    expect(parseAutonomyLevel("strict")).toBe("strict");
    expect(parseAutonomyLevel("normal")).toBe("normal");
    expect(parseAutonomyLevel("high")).toBe("high");
    expect(parseAutonomyLevel("yolo")).toBe("yolo");
  });

  it("accepts aliases", () => {
    expect(parseAutonomyLevel("paranoid")).toBe("strict");
    expect(parseAutonomyLevel("balanced")).toBe("normal");
    expect(parseAutonomyLevel("fast")).toBe("high");
    expect(parseAutonomyLevel("auto-approve")).toBe("yolo");
    expect(parseAutonomyLevel("FULL-YOLO")).toBe("yolo");
  });

  it("accepts super-yolo aliases", () => {
    expect(parseAutonomyLevel("super-yolo")).toBe("super-yolo");
    expect(parseAutonomyLevel("superyolo")).toBe("super-yolo");
    expect(parseAutonomyLevel("unsafe")).toBe("super-yolo");
    expect(parseAutonomyLevel("no-guards")).toBe("super-yolo");
    expect(parseAutonomyLevel("BYPASS")).toBe("super-yolo");
  });

  it("isSuperYolo guard", () => {
    expect(isSuperYolo("super-yolo")).toBe(true);
    expect(isSuperYolo("yolo")).toBe(false);
  });

  it("returns null for unknown", () => {
    expect(parseAutonomyLevel("whatever")).toBeNull();
    expect(parseAutonomyLevel("")).toBeNull();
    expect(parseAutonomyLevel(undefined)).toBeNull();
    expect(parseAutonomyLevel(42)).toBeNull();
  });
});

describe("isAutonomyLevel", () => {
  it("guards the type", () => {
    expect(isAutonomyLevel("yolo")).toBe(true);
    expect(isAutonomyLevel("turbo")).toBe(false);
  });
});
