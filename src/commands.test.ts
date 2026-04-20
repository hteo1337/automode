import { describe, it, expect, vi } from "vitest";
import { runAutomodeCommand, helpText } from "./commands.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { Scheduler } from "./engine/scheduler.js";
import type { AutomodeConfig, TaskState } from "./types.js";

const cfg: AutomodeConfig = { ...DEFAULT_CONFIG, discoveredAcpxAgents: ["codex", "kimi"] };

function stubScheduler(overrides: Partial<Scheduler> = {}): Scheduler {
  const base = {
    list: vi.fn(() => [] as TaskState[]),
    get: vi.fn(() => null),
    startTask: vi.fn(async (opts: { goal: string; mode?: string }) => ({
      id: "t-new",
      goal: opts.goal,
      mode: opts.mode ?? "hybrid",
    }) as unknown as TaskState),
    stopTask: vi.fn(async () => true),
    pauseTask: vi.fn(async () => true),
    resumeTask: vi.fn(async () => true),
  };
  return { ...base, ...overrides } as unknown as Scheduler;
}

describe("runAutomodeCommand", () => {
  it("help returns help text", async () => {
    const r = await runAutomodeCommand(stubScheduler(), { args: "help" });
    expect(r.text).toContain("autonomous focus mode");
  });

  it("status lists tasks", async () => {
    const s = stubScheduler({
      list: vi.fn(() => [
        {
          id: "t1",
          status: "running",
          goal: "do",
          mode: "goal",
          turnCount: 0,
          createdAt: Date.now(),
          caps: { maxTurns: 5, maxDurationSec: 60 },
        } as TaskState,
      ]),
    });
    const r = await runAutomodeCommand(s, { args: "status" });
    expect(r.text).toContain("t1");
  });

  it("no-subcommand starts a hybrid task with the rest as goal", async () => {
    const startMock = vi.fn(async (opts) => ({ id: "t-new", goal: opts.goal, mode: opts.mode } as TaskState));
    const s = stubScheduler({ startTask: startMock });
    const r = await runAutomodeCommand(s, { args: "fix the failing tests" }, cfg);
    expect(startMock).toHaveBeenCalled();
    expect(r.text).toContain("t-new");
  });

  it("plan subcommand sets planFirst", async () => {
    const startMock = vi.fn(async (opts: { goal: string; planFirst?: boolean }) => ({
      id: "t-p",
      goal: opts.goal,
      mode: "hybrid",
    } as unknown as TaskState));
    const s = stubScheduler({ startTask: startMock });
    await runAutomodeCommand(s, { args: "plan refactor auth" }, cfg);
    const call = startMock.mock.calls[0]?.[0] as { planFirst?: boolean; goal: string };
    expect(call?.planFirst).toBe(true);
    expect(call?.goal).toBe("refactor auth");
  });

  it("interval parses duration", async () => {
    const startMock = vi.fn(async (opts: { intervalSec?: number; goal: string }) => ({
      id: "t-i",
      goal: opts.goal,
      mode: "interval",
    } as unknown as TaskState));
    const s = stubScheduler({ startTask: startMock });
    await runAutomodeCommand(s, { args: "interval 5m check CI" }, cfg);
    const call = startMock.mock.calls[0]?.[0] as { intervalSec?: number; goal: string };
    expect(call?.intervalSec).toBe(300);
    expect(call?.goal).toBe("check CI");
  });

  it("--agent flag overrides default and infers backend", async () => {
    const startMock = vi.fn(async (opts: { agent?: string; backend?: string; goal: string }) =>
      ({ id: "t-agent", goal: opts.goal, mode: "hybrid" } as unknown as TaskState),
    );
    const s = stubScheduler({ startTask: startMock });
    await runAutomodeCommand(s, { args: "--agent=kimi refactor auth" }, cfg);
    const call = startMock.mock.calls[0]?.[0] as { agent?: string; backend?: string };
    expect(call?.agent).toBe("kimi");
    expect(call?.backend).toBe("acpx"); // auto-inferred for non-Claude
  });

  it("--agent with claude-prefix infers claude-acp backend", async () => {
    const startMock = vi.fn(async (opts: { agent?: string; backend?: string; goal: string }) =>
      ({ id: "t-claude", goal: opts.goal, mode: "hybrid" } as unknown as TaskState),
    );
    const s = stubScheduler({ startTask: startMock });
    await runAutomodeCommand(s, { args: "-a claude-bf do something" }, cfg);
    const call = startMock.mock.calls[0]?.[0] as { agent?: string; backend?: string };
    expect(call?.agent).toBe("claude-bf");
    expect(call?.backend).toBe("claude-acp");
  });

  it("--backend explicit overrides inference", async () => {
    const startMock = vi.fn(async (opts: { goal: string; agent?: string; backend?: string }) =>
      ({ id: "t-b", goal: opts.goal, mode: "hybrid" } as unknown as TaskState),
    );
    const s = stubScheduler({ startTask: startMock });
    await runAutomodeCommand(
      s,
      { args: "--agent=claude-bf --backend=acpx something" },
      cfg,
    );
    const call = startMock.mock.calls[0]?.[0] as { agent?: string; backend?: string };
    expect(call?.backend).toBe("acpx");
  });

  it("stop without id errors", async () => {
    const r = await runAutomodeCommand(stubScheduler(), { args: "stop" });
    expect(r.text).toMatch(/Usage/);
  });
});

describe("helpText", () => {
  it("mentions all subcommands", () => {
    const h = helpText();
    for (const cmd of ["plan", "interval", "status", "stop", "pause", "resume", "inspect"]) {
      expect(h).toContain(cmd);
    }
  });
});
