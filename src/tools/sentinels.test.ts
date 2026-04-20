import { describe, it, expect } from "vitest";
import { detectComplete } from "./complete.js";
import { detectEscalate } from "./escalate.js";
import { detectReschedule } from "./reschedule.js";

describe("detectComplete", () => {
  it("extracts from xml tag", () => {
    const r = detectComplete("All done.\n<automode:complete>Built X, tests green</automode:complete>\n");
    expect(r?.summary).toBe("Built X, tests green");
  });

  it("extracts from sentinel line", () => {
    const r = detectComplete("Work finished.\nAUTOMODE_COMPLETE: refactored auth module");
    expect(r?.summary).toBe("refactored auth module");
  });

  it("extracts from tool-call style", () => {
    const r = detectComplete('automode.complete(summary: "merged PR #123")');
    expect(r?.summary).toBe("merged PR #123");
  });

  it("returns null for unrelated text", () => {
    expect(detectComplete("I completed a subtask, continuing...")).toBeNull();
  });
});

describe("detectEscalate", () => {
  it("extracts xml tag with severity", () => {
    const r = detectEscalate('<automode:escalate severity="block">rm -rf detected</automode:escalate>');
    expect(r?.severity).toBe("block");
    expect(r?.reason).toBe("rm -rf detected");
  });

  it("defaults severity to warn", () => {
    const r = detectEscalate("<automode:escalate>unsure about schema</automode:escalate>");
    expect(r?.severity).toBe("warn");
  });

  it("parses sentinel line with severity", () => {
    const r = detectEscalate("AUTOMODE_ESCALATE: info | minor ambiguity");
    expect(r?.severity).toBe("info");
    expect(r?.reason).toContain("minor");
  });

  it("returns null when absent", () => {
    expect(detectEscalate("nothing to see")).toBeNull();
  });
});

describe("detectReschedule", () => {
  it("extracts xml tag with seconds", () => {
    const r = detectReschedule('<automode:reschedule seconds="300">waiting on build</automode:reschedule>');
    expect(r?.delaySec).toBe(300);
    expect(r?.note).toBe("waiting on build");
  });

  it("parses sentinel line", () => {
    const r = detectReschedule("AUTOMODE_RESCHEDULE: 600 | CI pending");
    expect(r?.delaySec).toBe(600);
    expect(r?.note).toContain("CI");
  });

  it("clamps invalid values", () => {
    const r = detectReschedule("<automode:reschedule seconds=\"999999999\">x</automode:reschedule>");
    expect(r?.delaySec).toBeLessThanOrEqual(86400);
  });

  it("returns null when absent", () => {
    expect(detectReschedule("normal output")).toBeNull();
  });
});
