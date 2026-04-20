import { describe, it, expect } from "vitest";
import { parseMenuData, buildMenu, MENU_PREFIX } from "./menu.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { Scheduler } from "../engine/scheduler.js";
import type { Preferences } from "../engine/preferences.js";

function fakeScheduler(tasks: Array<{ status: string }> = []): Scheduler {
  return {
    list: () => tasks.map((t) => ({ status: t.status })),
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
    });
  });

  it("parses action with arg", () => {
    expect(parseMenuData(MENU_PREFIX + "autonomy:yolo")).toEqual({
      kind: "action",
      action: "autonomy",
      arg: "yolo",
    });
  });

  it("parses nav", () => {
    expect(parseMenuData(MENU_PREFIX + "nav:budget")).toEqual({
      kind: "nav",
      page: "budget",
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
    expect(allCallbacks).toContain(MENU_PREFIX + "status");
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
