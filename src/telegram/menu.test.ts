import { describe, it, expect } from "vitest";
import { parseMenuData, buildMenu, MENU_PREFIX } from "./menu.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { Scheduler } from "../engine/scheduler.js";
import type { Preferences } from "../engine/preferences.js";

function fakeScheduler(tasks: Array<Record<string, unknown>> = []): Scheduler {
  return {
    list: () => tasks,
    get: (id: string) => tasks.find((t) => (t as { id?: string }).id === id) ?? null,
  } as unknown as Scheduler;
}

function fakePrefs(p: Record<string, unknown> = {}): Preferences {
  return { get: () => p } as unknown as Preferences;
}

describe("parseMenuData", () => {
  it("rejects non-menu callback_data", () => {
    expect(parseMenuData("automode:t1:e1:approve")).toBeNull();
    expect(parseMenuData("random:thing")).toBeNull();
  });

  it("parses leaf action", () => {
    expect(parseMenuData(MENU_PREFIX + "status")).toEqual({
      kind: "action",
      action: "status",
      arg: undefined,
      args: [],
    });
  });

  it("parses action with arg", () => {
    expect(parseMenuData(MENU_PREFIX + "autonomy:yolo")).toEqual({
      kind: "action",
      action: "autonomy",
      arg: "yolo",
      args: ["yolo"],
    });
  });

  it("parses nav", () => {
    expect(parseMenuData(MENU_PREFIX + "nav:budget")).toEqual({
      kind: "nav",
      page: "budget",
      arg: undefined,
    });
  });

  it("parses nav with arg (task id)", () => {
    expect(parseMenuData(MENU_PREFIX + "nav:task:abc123")).toEqual({
      kind: "nav",
      page: "task",
      arg: "abc123",
    });
  });

  it("parses parameterised action preserving task id", () => {
    expect(parseMenuData(MENU_PREFIX + "tail:task-xyz")).toEqual({
      kind: "action",
      action: "tail",
      arg: "task-xyz",
      args: ["task-xyz"],
    });
  });

  it("returns null on malformed", () => {
    expect(parseMenuData(MENU_PREFIX)).toBeNull();
    expect(parseMenuData(MENU_PREFIX + "nav:")).toBeNull();
  });
});

describe("buildMenu", () => {
  it("root menu includes core actions", () => {
    const m = buildMenu("root", fakeScheduler(), DEFAULT_CONFIG, fakePrefs());
    const allCallbacks = m.buttons.flat().map((b) => b.callback_data);
    expect(allCallbacks).toContain(MENU_PREFIX + "nav:tasks");
    expect(allCallbacks).toContain(MENU_PREFIX + "doctor");
    expect(allCallbacks).toContain(MENU_PREFIX + "help");
    expect(allCallbacks).toContain(MENU_PREFIX + "newtask");
    expect(allCallbacks).toContain(MENU_PREFIX + "nav:autonomy");
    expect(allCallbacks).toContain(MENU_PREFIX + "nav:budget");
  });

  it("root menu text mentions task count", () => {
    const m1 = buildMenu("root", fakeScheduler([]), DEFAULT_CONFIG, fakePrefs());
    expect(m1.text).toContain("no tasks running");
    const m2 = buildMenu(
      "root",
      fakeScheduler([{ status: "running" }, { status: "planning" }]),
      DEFAULT_CONFIG,
      fakePrefs(),
    );
    expect(m2.text).toMatch(/2 running tasks/);
  });

  it("tasks page lists live tasks as inspect buttons", () => {
    const tasks = [
      { status: "running", id: "abc1234", turnCount: 3, caps: { maxTurns: 50 }, totalCostUsd: 0.12, goal: "do the thing" },
      { status: "waiting", id: "def5678", turnCount: 1, caps: { maxTurns: 10 }, goal: "second" },
    ];
    const m = buildMenu("tasks", fakeScheduler(tasks), DEFAULT_CONFIG, fakePrefs());
    const cbs = m.buttons.flat().map((b) => b.callback_data);
    expect(cbs).toContain(`${MENU_PREFIX}inspect:abc1234`);
    expect(cbs).toContain(`${MENU_PREFIX}inspect:def5678`);
    expect(cbs).toContain(`${MENU_PREFIX}nav:tasks:running:1`); // refresh
    expect(cbs).toContain(`${MENU_PREFIX}nav:root`); // back
  });

  it("tasks page shows empty state when nothing exists", () => {
    const m = buildMenu("tasks", fakeScheduler([]), DEFAULT_CONFIG, fakePrefs());
    expect(m.text).toMatch(/No running tasks/);
  });

  it("tasks page paginates at 8 per page", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i.toString().padStart(3, "0")}`,
      status: "running",
      turnCount: i,
      caps: { maxTurns: 50 },
      updatedAt: Date.now() + i, // newest first after sort
      totalCostUsd: 0.01 * i,
      goal: `goal ${i}`,
    }));
    const m = buildMenu("tasks", fakeScheduler(tasks), DEFAULT_CONFIG, fakePrefs());
    const cbs = m.buttons.flat().map((b) => b.callback_data);
    const inspectCount = cbs.filter((c) => c?.startsWith(`${MENU_PREFIX}inspect:`)).length;
    expect(inspectCount).toBe(8);
    expect(cbs).toContain(`${MENU_PREFIX}nav:tasks:running:2`); // next page
    expect(m.text).toMatch(/Showing 1–8 of 20/);
  });

  it("tasks page respects explicit page arg", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i.toString().padStart(3, "0")}`,
      status: "running",
      turnCount: i,
      caps: { maxTurns: 50 },
      updatedAt: Date.now() + i,
      goal: `g${i}`,
    }));
    const m = buildMenu("tasks", fakeScheduler(tasks), DEFAULT_CONFIG, fakePrefs(), "running:3");
    expect(m.text).toMatch(/Showing 17–20 of 20/);
    const cbs = m.buttons.flat().map((b) => b.callback_data);
    // Prev should link to page 2, no next link
    expect(cbs).toContain(`${MENU_PREFIX}nav:tasks:running:2`);
  });

  it("tasks filter tabs include counts and only show non-empty tabs", () => {
    const tasks = [
      { id: "a", status: "running", turnCount: 0, caps: { maxTurns: 50 }, goal: "" },
      { id: "b", status: "done", turnCount: 0, caps: { maxTurns: 50 }, goal: "" },
      { id: "c", status: "done", turnCount: 0, caps: { maxTurns: 50 }, goal: "" },
      { id: "d", status: "failed", turnCount: 0, caps: { maxTurns: 50 }, goal: "" },
    ];
    const m = buildMenu("tasks", fakeScheduler(tasks), DEFAULT_CONFIG, fakePrefs());
    const allTabs = m.buttons
      .flat()
      .filter((b) => b.callback_data?.startsWith(`${MENU_PREFIX}nav:tasks:`))
      .map((b) => b.text);
    expect(allTabs.some((t) => /Running 1\b/.test(t))).toBe(true);
    expect(allTabs.some((t) => /All 4\b/.test(t))).toBe(true);
    expect(allTabs.some((t) => /Done 2\b/.test(t))).toBe(true);
    expect(allTabs.some((t) => /Failed 1\b/.test(t))).toBe(true);
  });

  it("task rows include title when present", () => {
    const tasks = [
      {
        id: "tabc123",
        status: "running",
        turnCount: 2,
        caps: { maxTurns: 50 },
        title: "Fix Login Bug",
        goal: "please fix the broken login page on staging",
        updatedAt: Date.now(),
        totalCostUsd: 0.02,
      },
    ];
    const m = buildMenu("tasks", fakeScheduler(tasks), DEFAULT_CONFIG, fakePrefs());
    const rowButton = m.buttons
      .flat()
      .find((b) => b.callback_data === `${MENU_PREFIX}inspect:tabc123`);
    expect(rowButton?.text).toMatch(/Fix Login Bug/);
    expect(rowButton?.text).toMatch(/t2\/50/);
  });

  it("task rows fall back to goal when title missing", () => {
    const tasks = [
      {
        id: "told",
        status: "done",
        turnCount: 5,
        caps: { maxTurns: 50 },
        goal: "refactor the payments module",
        updatedAt: Date.now(),
        totalCostUsd: 0.11,
      },
    ];
    const m = buildMenu("tasks", fakeScheduler(tasks), DEFAULT_CONFIG, fakePrefs(), "all:1");
    const rowButton = m.buttons
      .flat()
      .find((b) => b.callback_data === `${MENU_PREFIX}inspect:told`);
    expect(rowButton?.text).toMatch(/refactor the payments module/);
  });

  it("task detail page shows tail/pause/stop when live", () => {
    const tasks = [
      {
        status: "running",
        id: "xyz",
        turnCount: 2,
        caps: { maxTurns: 50, maxDurationSec: 3600 },
        totalCostUsd: 0.05,
        goal: "live one",
        config: { defaultAgent: "a", autonomy: "normal", backend: "acp" },
        mode: "hybrid",
        startedAt: Date.now() - 60_000,
      },
    ];
    const m = buildMenu("task", fakeScheduler(tasks), DEFAULT_CONFIG, fakePrefs(), "xyz");
    const cbs = m.buttons.flat().map((b) => b.callback_data);
    expect(cbs).toContain(`${MENU_PREFIX}tail:xyz`);
    expect(cbs).toContain(`${MENU_PREFIX}taskpause:xyz`);
    expect(cbs).toContain(`${MENU_PREFIX}taskstop:xyz`);
    expect(cbs).toContain(`${MENU_PREFIX}nav:tasks`);
  });

  it("task detail page handles unknown task id gracefully", () => {
    const m = buildMenu("task", fakeScheduler([]), DEFAULT_CONFIG, fakePrefs(), "ghost");
    expect(m.text).toMatch(/not found/);
  });

  it("autonomy menu has all 5 levels", () => {
    const m = buildMenu("autonomy", fakeScheduler(), DEFAULT_CONFIG, fakePrefs());
    const callbacks = m.buttons.flat().map((b) => b.callback_data);
    for (const level of ["strict", "normal", "high", "yolo", "super-yolo"]) {
      expect(callbacks).toContain(`${MENU_PREFIX}autonomy:${level}`);
    }
    expect(callbacks).toContain(MENU_PREFIX + "nav:root");
  });

  it("budget menu has presets and off", () => {
    const m = buildMenu("budget", fakeScheduler(), DEFAULT_CONFIG, fakePrefs());
    const callbacks = m.buttons.flat().map((b) => b.callback_data);
    for (const amount of ["1", "5", "25", "100", "0"]) {
      expect(callbacks).toContain(`${MENU_PREFIX}budget:${amount}`);
    }
  });

  it("verbose menu has 0-3", () => {
    const m = buildMenu("verbose", fakeScheduler(), DEFAULT_CONFIG, fakePrefs());
    const callbacks = m.buttons.flat().map((b) => b.callback_data);
    for (const level of ["0", "1", "2", "3"]) {
      expect(callbacks).toContain(`${MENU_PREFIX}verbose:${level}`);
    }
  });

  it("reflects current prefs in the text", () => {
    const p = fakePrefs({ autonomy: "yolo", budgetUsd: 25, verbosity: 2 });
    expect(buildMenu("autonomy", fakeScheduler(), DEFAULT_CONFIG, p).text).toContain("`yolo`");
    expect(buildMenu("budget", fakeScheduler(), DEFAULT_CONFIG, p).text).toContain("$25.00");
    expect(buildMenu("verbose", fakeScheduler(), DEFAULT_CONFIG, p).text).toContain("current: 2");
  });
});
