import { describe, it, expect } from "vitest";
import { shouldRouteToAutomode } from "./default-mode.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { AutomodeConfig } from "../types.js";
import type { Preferences } from "./preferences.js";

function cfg(overrides: Partial<AutomodeConfig["defaultMode"]> = {}): AutomodeConfig {
  return {
    ...DEFAULT_CONFIG,
    defaultMode: { ...DEFAULT_CONFIG.defaultMode, ...overrides },
  };
}

function fakePrefs(chatDefaults: Record<string, boolean> = {}): Preferences {
  return {
    get: () => ({ chatDefaults }),
  } as unknown as Preferences;
}

describe("shouldRouteToAutomode", () => {
  it("off when default-mode disabled and no chat override", () => {
    const r = shouldRouteToAutomode("fix the tests", "telegram:1", cfg({ enabled: false }), fakePrefs());
    expect(r.route).toBe(false);
  });

  it("per-chat true overrides config false", () => {
    const r = shouldRouteToAutomode(
      "fix the tests",
      "telegram:1",
      cfg({ enabled: false, gate: "any" }),
      fakePrefs({ "telegram:1": true }),
    );
    expect(r.route).toBe(true);
  });

  it("per-chat false overrides config true", () => {
    const r = shouldRouteToAutomode(
      "fix the tests",
      "telegram:1",
      cfg({ enabled: true, gate: "any" }),
      fakePrefs({ "telegram:1": false }),
    );
    expect(r.route).toBe(false);
  });

  it("gate=any routes every non-empty message", () => {
    const r = shouldRouteToAutomode("hi", undefined, cfg({ enabled: true, gate: "any" }), undefined);
    expect(r.route).toBe(true);
  });

  it("gate=verb matches known verb prefix", () => {
    const c = cfg({ enabled: true, gate: "verb" });
    expect(shouldRouteToAutomode("fix the bug", undefined, c, undefined).route).toBe(true);
    expect(shouldRouteToAutomode("Fix: the bug", undefined, c, undefined).route).toBe(true);
    expect(shouldRouteToAutomode("thanks!", undefined, c, undefined).route).toBe(false);
    expect(shouldRouteToAutomode("hello there", undefined, c, undefined).route).toBe(false);
  });

  it("gate=length requires minWords", () => {
    const c = cfg({ enabled: true, gate: "length", minWords: 5 });
    expect(shouldRouteToAutomode("one two three four five", undefined, c, undefined).route).toBe(true);
    expect(shouldRouteToAutomode("one two three four", undefined, c, undefined).route).toBe(false);
  });

  it("gate=verbOrLength matches either condition", () => {
    const c = cfg({ enabled: true, gate: "verbOrLength", minWords: 10 });
    // short but verb-starting
    expect(shouldRouteToAutomode("sort them", undefined, c, undefined).route).toBe(true);
    // long but no verb
    expect(
      shouldRouteToAutomode(
        "the quick brown fox jumps over the lazy dog and then some more words",
        undefined,
        c,
        undefined,
      ).route,
    ).toBe(true);
    // neither
    expect(shouldRouteToAutomode("thanks a lot", undefined, c, undefined).route).toBe(false);
  });

  it("returns false on empty or whitespace", () => {
    const c = cfg({ enabled: true, gate: "any" });
    expect(shouldRouteToAutomode("", undefined, c, undefined).route).toBe(false);
    expect(shouldRouteToAutomode("   ", undefined, c, undefined).route).toBe(false);
  });
});
