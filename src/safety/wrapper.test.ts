import { describe, it, expect } from "vitest";
import { buildPreToolUseHook, buildClaudeSettings, buildWrapperScript } from "./wrapper.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { TaskState } from "../types.js";

const TASK: TaskState = {
  id: "t-test",
  version: 1,
  goal: "g",
  mode: "goal",
  status: "pending",
  createdAt: 0,
  updatedAt: 0,
  cwd: "/tmp",
  scope: { paths: [] },
  caps: { maxTurns: 5, maxDurationSec: 60 },
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
  turnCount: 0,
  escalations: [],
};

describe("safety/wrapper", () => {
  it("generates PreToolUse hook embedding allowlist", () => {
    const hook = buildPreToolUseHook(DEFAULT_CONFIG, "t-test", "/tmp/work", []);
    expect(hook).toContain("automode PreToolUse hook");
    expect(hook).toContain("Read");
    expect(hook).toContain("not in allowlist");
  });

  it("embeds scope roots for path-scope enforcement", () => {
    const hook = buildPreToolUseHook(
      DEFAULT_CONFIG,
      "t-x",
      "/home/me/project",
      ["/tmp/shared"],
    );
    expect(hook).toContain("SCOPE_ROOTS");
    expect(hook).toContain("/home/me/project");
    expect(hook).toContain("/tmp/shared");
    expect(hook).toContain("WRITE_TOOLS");
  });

  it("super-yolo hook is a no-op allow-everything shim", () => {
    const hook = buildPreToolUseHook(
      DEFAULT_CONFIG,
      "t-sy",
      "/home/me/project",
      [],
      true,
    );
    expect(hook).toContain("super-yolo");
    expect(hook).toContain('"decision":"allow"');
    // Must not embed any of the enforcement logic.
    expect(hook).not.toContain("WRITE_TOOLS");
    expect(hook).not.toContain("DENY_BASH");
  });

  it("claude settings registers a PreToolUse hook", () => {
    const json = JSON.parse(buildClaudeSettings("/tmp/hook.sh"));
    expect(json.hooks.PreToolUse).toBeDefined();
    expect(json.hooks.PreToolUse[0].hooks[0].command).toBe("/tmp/hook.sh");
  });

  it("wrapper script sets CLAUDE_CONFIG_DIR", () => {
    const paths = {
      root: "/r",
      state: "/r/s.json",
      turns: "/r/turns",
      escalations: "/r/esc",
      workspace: "/r/ws",
      workers: "/r/w",
      claudeConfig: "/r/cc",
      claudeSettings: "/r/cc/settings.json",
      wrapperSh: "/r/wrap.sh",
      hookSh: "/r/hook.sh",
    };
    const sh = buildWrapperScript(TASK, paths);
    expect(sh).toContain("CLAUDE_CONFIG_DIR");
    expect(sh).toContain("/r/cc");
    expect(sh).toContain("AUTOMODE_TASK_ID");
  });
});
