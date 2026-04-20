import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Preferences, inferBackend } from "./preferences.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "automode-prefs-"));
}

describe("Preferences", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });

  it("reads empty when no file exists", () => {
    const p = new Preferences(dir);
    expect(p.get()).toEqual({});
  });

  it("round-trips values", () => {
    const p = new Preferences(dir);
    p.set({ defaultAgent: "kimi" });
    const q = new Preferences(dir);
    expect(q.get().defaultAgent).toBe("kimi");
  });

  it("merges on subsequent set", () => {
    const p = new Preferences(dir);
    p.set({ defaultAgent: "kimi" });
    p.set({ defaultBackend: "acpx" });
    expect(p.get().defaultAgent).toBe("kimi");
    expect(p.get().defaultBackend).toBe("acpx");
  });

  it("reset clears the file", () => {
    const p = new Preferences(dir);
    p.set({ defaultAgent: "codex" });
    p.reset();
    expect(p.get()).toEqual({});
    // fresh load should also be empty
    const q = new Preferences(dir);
    expect(q.get()).toEqual({});
  });

  it("writes file with restrictive mode", () => {
    const p = new Preferences(dir);
    p.set({ defaultAgent: "a" });
    const file = path.join(dir, "defaults.json");
    const stat = fs.statSync(file);
    // 0o600 lower bits — on some FSes the mode returns full 0o100600
    expect((stat.mode & 0o777)).toBe(0o600);
  });
});

describe("inferBackend", () => {
  it("returns claude-acp for Claude agents", () => {
    expect(inferBackend("claude")).toBe("claude-acp");
    expect(inferBackend("claude-bf")).toBe("claude-acp");
    expect(inferBackend("claude-vertex-opus47")).toBe("claude-acp");
    expect(inferBackend("Opus")).toBe("claude-acp");
    expect(inferBackend("sonnet-4")).toBe("claude-acp");
  });

  it("returns acpx for non-Claude agents", () => {
    expect(inferBackend("codex")).toBe("acpx");
    expect(inferBackend("kimi")).toBe("acpx");
    expect(inferBackend("gpt-5")).toBe("acpx");
    expect(inferBackend("glm-4.7")).toBe("acpx");
  });

  it("handles unknown / empty", () => {
    expect(inferBackend("")).toBe("acpx");
    expect(inferBackend("auto")).toBe("acpx");
  });
});
