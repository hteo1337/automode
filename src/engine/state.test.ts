import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore, newTaskId, migrateTaskOnLoad } from "./state.js";
import type { TaskState } from "../types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "automode-test-"));
}

function makeState(id: string): TaskState {
  return {
    id,
    version: 1,
    goal: "test goal",
    mode: "goal",
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd: "/tmp",
    scope: { paths: [] },
    caps: { maxTurns: 5, maxDurationSec: 60 },
    config: {
      defaultAgent: "a",
      backend: "claude-acp",
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
    turnCount: 0,
    escalations: [],
  };
}

describe("TaskStore", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new TaskStore(dir);
  });

  it("round-trips state", () => {
    const id = newTaskId();
    const s = makeState(id);
    store.save(s);
    const loaded = store.load(id);
    expect(loaded).not.toBeNull();
    expect(loaded?.goal).toBe("test goal");
  });

  it("lists task ids", () => {
    store.save(makeState("a1"));
    store.save(makeState("a2"));
    const ids = store.listTaskIds();
    expect(ids.sort()).toEqual(["a1", "a2"]);
  });

  it("filters running tasks", () => {
    store.save(makeState("r1"));
    const done = makeState("d1");
    done.status = "done";
    store.save(done);
    const running = store.listRunning().map((s) => s.id);
    expect(running).toEqual(["r1"]);
  });

  it("appends turn audit", () => {
    store.save(makeState("t1"));
    store.appendTurn("t1", {
      index: 1,
      startedAt: 1,
      endedAt: 2,
      backend: "b",
      agent: "a",
      requestId: "r",
      prompt: "p",
      events: [],
      toolCalls: [],
    });
    const p = store.paths("t1");
    const files = fs.readdirSync(p.turns);
    expect(files).toHaveLength(1);
  });

  it("saves escalation to its own file", () => {
    store.save(makeState("e1"));
    store.saveEscalation("e1", {
      id: "esc1",
      taskId: "e1",
      reason: "test",
      severity: "warn",
      raisedAt: 1,
    });
    const loaded = store.loadEscalation("e1", "esc1");
    expect(loaded?.reason).toBe("test");
  });

  it("newTaskId produces unique ids", () => {
    const a = newTaskId();
    const b = newTaskId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^t[a-z0-9]+-[a-z0-9]+$/);
  });

  it("migrates bogus chatId to undefined on load (Fix C / 0.3.4)", () => {
    const s = makeState("migrate-1");
    s.telegram = { chatId: "telegram", accountId: "default" } as TaskState["telegram"];
    store.save(s);
    const loaded = store.load("migrate-1");
    expect(loaded?.telegram?.chatId).toBeUndefined();
    expect(loaded?.telegram?.accountId).toBe("default");
  });

  it("preserves legitimate chatId on load", () => {
    const s = makeState("migrate-2");
    s.telegram = { chatId: "telegram:8743540866", accountId: "default" } as TaskState["telegram"];
    store.save(s);
    const loaded = store.load("migrate-2");
    expect(loaded?.telegram?.chatId).toBe("telegram:8743540866");
  });
});

describe("migrateTaskOnLoad (unit)", () => {
  it("is idempotent on clean state", () => {
    const s = {
      id: "x",
      telegram: { chatId: "telegram:42", accountId: "default" },
    } as unknown as TaskState;
    migrateTaskOnLoad(s);
    migrateTaskOnLoad(s);
    expect(s.telegram?.chatId).toBe("telegram:42");
  });

  it("strips every known channel-kind literal", () => {
    for (const bad of ["telegram", "slack", "discord", "  telegram  ", ""]) {
      const s = {
        id: "x",
        telegram: { chatId: bad, accountId: "default" },
      } as unknown as TaskState;
      migrateTaskOnLoad(s);
      expect(s.telegram?.chatId).toBeUndefined();
    }
  });

  it("leaves missing telegram block alone", () => {
    const s = { id: "x" } as unknown as TaskState;
    migrateTaskOnLoad(s);
    expect(s.telegram).toBeUndefined();
  });
});
