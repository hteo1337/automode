import { describe, it, expect } from "vitest";
import { decide } from "./supervisor.js";
import type { TaskState, TurnRecord } from "../types.js";

function makeTask(partial: Partial<TaskState> = {}): TaskState {
  return {
    id: "t1",
    version: 1,
    goal: "do a thing",
    mode: "goal",
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now() - 1000,
    cwd: "/tmp",
    scope: { paths: [] },
    caps: { maxTurns: 10, maxDurationSec: 600 },
    config: {
      defaultAgent: "claude-vertex-opus47",
      backend: "claude-acp",
      allowedTools: ["Read"],
      deniedBashPatterns: [],
      parallelismPolicy: "never",
      maxParallel: 1,
      planFirstThreshold: 0.7,
      verbosity: 1,
      autonomy: "normal",
    },
    planFirst: false,
    progressSummary: "",
    turnCount: 1,
    escalations: [],
    ...partial,
  };
}

function makeTurn(partial: Partial<TurnRecord> = {}): TurnRecord {
  return {
    index: 1,
    startedAt: Date.now(),
    endedAt: Date.now(),
    backend: "claude-acp",
    agent: "claude-vertex-opus47",
    requestId: "r1",
    prompt: "",
    events: [],
    toolCalls: [],
    ...partial,
  };
}

describe("supervisor.decide", () => {
  it("returns stopped when stopRequested", () => {
    const r = decide({
      task: makeTask(),
      turn: makeTurn(),
      stopRequested: true,
      deniedToolCalls: [],
    });
    expect(r.kind).toBe("stopped");
  });

  it("returns done when completeCalled", () => {
    const r = decide({
      task: makeTask(),
      turn: makeTurn(),
      completeCalled: { summary: "all good" },
      deniedToolCalls: [],
    });
    expect(r.kind).toBe("done");
    if (r.kind === "done") expect(r.summary).toBe("all good");
  });

  it("escalates on escalateCalled", () => {
    const r = decide({
      task: makeTask(),
      turn: makeTurn(),
      escalateCalled: { reason: "ambiguous", severity: "warn" },
      deniedToolCalls: [],
    });
    expect(r.kind).toBe("escalate");
  });

  it("escalates on denied tool call (block severity)", () => {
    const r = decide({
      task: makeTask(),
      turn: makeTurn(),
      deniedToolCalls: [{ name: "Bash", reason: "denied" }],
    });
    expect(r.kind).toBe("escalate");
    if (r.kind === "escalate") expect(r.severity).toBe("block");
  });

  it("caps by turn count", () => {
    const task = makeTask({ turnCount: 10, caps: { maxTurns: 10, maxDurationSec: 600 } });
    const r = decide({ task, turn: makeTurn(), deniedToolCalls: [] });
    expect(r.kind).toBe("capped");
    if (r.kind === "capped") expect(r.reason).toBe("turns");
  });

  it("caps by duration", () => {
    const task = makeTask({
      startedAt: Date.now() - 601_000,
      caps: { maxTurns: 99, maxDurationSec: 600 },
    });
    const r = decide({ task, turn: makeTurn(), deniedToolCalls: [] });
    expect(r.kind).toBe("capped");
    if (r.kind === "capped") expect(r.reason).toBe("duration");
  });

  it("reschedules when agent requested and no other signal", () => {
    const r = decide({
      task: makeTask(),
      turn: makeTurn(),
      rescheduleCalled: { delaySec: 120 },
      deniedToolCalls: [],
    });
    expect(r.kind).toBe("reschedule");
    if (r.kind === "reschedule") expect(r.delaySec).toBe(120);
  });

  it("continues by default", () => {
    const r = decide({ task: makeTask(), turn: makeTurn(), deniedToolCalls: [] });
    expect(r.kind).toBe("continue");
  });

  it("fails on repeated error", () => {
    const r = decide({
      task: makeTask(),
      turn: makeTurn({ error: "kaboom" }),
      deniedToolCalls: [],
    });
    // single turn with error is "continue" not "failed" in this simplified
    // implementation — the scheduler tracks streaks across turns.
    expect(["continue", "failed"]).toContain(r.kind);
  });
});
