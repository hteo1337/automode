import { describe, it, expect } from "vitest";
import { buildLedger, formatLedger, windowMs } from "./ledger.js";
import type { TaskState } from "../types.js";

function task(p: Partial<TaskState> & { id: string; createdAt: number }): TaskState {
  const base: TaskState = {
    id: p.id,
    version: 1,
    goal: "g",
    mode: "goal",
    status: p.status ?? "done",
    createdAt: p.createdAt,
    updatedAt: p.createdAt,
    cwd: "/tmp",
    scope: { paths: [] },
    caps: { maxTurns: 5, maxDurationSec: 60 },
    config: {
      defaultAgent: p.config?.defaultAgent ?? "kimi",
      backend: p.config?.backend ?? "acpx",
      allowedTools: [],
      deniedBashPatterns: [],
      parallelismPolicy: "never",
      maxParallel: 1,
      planFirstThreshold: 0.7,
      verbosity: 1,
      autonomy: "normal",
    },
    planFirst: false,
    progressSummary: "",
    turnCount: p.turnCount ?? 3,
    totalCostUsd: p.totalCostUsd ?? 0.05,
    escalations: [],
  } as TaskState;
  // Merge caller overrides last (except id/createdAt which were already applied).
  return { ...base, ...p } as TaskState;
}

describe("windowMs", () => {
  it("day window is last 24h", () => {
    const now = 1_000_000_000_000;
    const w = windowMs("day", now);
    expect(w.until).toBe(now);
    expect(w.since).toBe(now - 24 * 3600 * 1000);
  });
  it("all has since=0", () => {
    expect(windowMs("all", 42).since).toBe(0);
  });
});

describe("buildLedger", () => {
  const now = Date.now();
  const tasks = [
    task({ id: "a", createdAt: now - 1000, totalCostUsd: 1.00, status: "done", config: { defaultAgent: "kimi" } as TaskState["config"] }),
    task({ id: "b", createdAt: now - 2000, totalCostUsd: 0.25, status: "failed", config: { defaultAgent: "codex" } as TaskState["config"] }),
    task({ id: "c", createdAt: now - 3000, totalCostUsd: 2.50, status: "done", config: { defaultAgent: "kimi" } as TaskState["config"] }),
    // outside window
    task({ id: "old", createdAt: now - 10 * 24 * 3600 * 1000, totalCostUsd: 99, status: "done", config: { defaultAgent: "kimi" } as TaskState["config"] }),
  ];

  it("aggregates costs in the day window", () => {
    const r = buildLedger(tasks, "day");
    expect(r.count).toBe(3);
    expect(r.totalCostUsd).toBeCloseTo(1 + 0.25 + 2.5, 4);
    expect(r.byStatus.done).toBe(2);
    expect(r.byStatus.failed).toBe(1);
    expect(r.byAgent.kimi.count).toBe(2);
    expect(r.byAgent.codex.costUsd).toBeCloseTo(0.25, 4);
  });

  it("'all' includes everything", () => {
    const r = buildLedger(tasks, "all");
    expect(r.count).toBe(4);
    expect(r.totalCostUsd).toBeCloseTo(1 + 0.25 + 2.5 + 99, 4);
  });

  it("topCost ordered by cost desc", () => {
    const r = buildLedger(tasks, "all");
    expect(r.topCost[0]?.id).toBe("old");
    expect(r.topCost[1]?.id).toBe("c");
  });

  it("format produces human-readable text", () => {
    const text = formatLedger(buildLedger(tasks, "day"));
    expect(text).toContain("automode ledger");
    expect(text).toContain("kimi");
    expect(text).toContain("codex");
  });
});
