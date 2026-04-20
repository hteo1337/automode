import { resolveConfig } from "./src/config.js";
import { TaskStore } from "./src/engine/state.js";
import { Scheduler } from "./src/engine/scheduler.js";
import { Dispatcher, sdkPreflight } from "./src/agents/dispatcher.js";
import { MultiChannelNotifier } from "./src/notifiers/multi.js";
import { runAutomodeCommand, helpText } from "./src/commands.js";
import { handleCallback } from "./src/telegram/callbacks.js";
import { parseToolCallText } from "./src/safety/allowlist.js";
import { Preferences } from "./src/engine/preferences.js";
import { makeTemplateStore } from "./src/engine/templates.js";
import { buildMetrics } from "./src/observability/otel.js";

type OpenClawPluginApi = {
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  pluginConfig?: unknown;
  config?: unknown;
  runtime?: unknown;
  registerCommand?: (opts: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: {
      senderId?: string;
      channel?: string;
      isAuthorizedSender?: boolean;
      args?: string;
      commandBody?: string;
    }) => Promise<{ text: string }> | { text: string };
  }) => void;
  registerCli?: (
    register: (args: { program: { command: (name: string) => unknown } }) => void,
    opts?: { commands?: string[] },
  ) => void;
  registerService?: (opts: { id: string; start: () => Promise<void> | void; stop: () => Promise<void> | void }) => void;
  registerHttpRoute?: (opts: {
    path: string;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    handler: (req: unknown, res: unknown) => Promise<boolean> | boolean;
  }) => void;
  on?: (
    event: string,
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> | unknown,
    opts?: { priority?: number },
  ) => void;
};

export default {
  id: "automode",
  name: "AutoMode",
  description: "Autonomous goal-driven execution with multi-agent orchestration",

  register(api: OpenClawPluginApi) {
    const log = api.logger;
    const cfg = resolveConfig(api.pluginConfig, api.config);
    if (cfg.discoveredAcpxAgents.length > 0) {
      log.info(
        `[automode] discovered acpx agents: ${cfg.discoveredAcpxAgents.join(", ")}`,
      );
    } else {
      log.warn(
        `[automode] no acpx agents discovered from root config. "auto" will resolve to '${cfg.defaultAgent}'. Configure plugins.entries.acpx.config.agents or set defaultAgent explicitly.`,
      );
    }
    // Boot-time config sanity checks — warn on drift the user can fix.
    if (
      cfg.defaultAgent !== "auto" &&
      cfg.discoveredAcpxAgents.length > 0 &&
      !cfg.discoveredAcpxAgents.includes(cfg.defaultAgent)
    ) {
      log.warn(
        `[automode] defaultAgent '${cfg.defaultAgent}' is not in discovered acpx agents (${cfg.discoveredAcpxAgents.join(", ")}). Tasks will rely on fallback.`,
      );
    }
    if (cfg.fallbackAgents.length === 0) {
      log.warn(
        `[automode] fallbackAgents is empty — a single-agent failure will fail the task immediately. Consider ['auto'].`,
      );
    }
    if (cfg.maxCostUsd > 0) {
      log.info(`[automode] cost cap enabled: $${cfg.maxCostUsd.toFixed(4)} / task`);
    }
    const store = new TaskStore(cfg.stateDir);
    const prefs = new Preferences(cfg.stateDir);
    const templates = makeTemplateStore(cfg.stateDir);
    const dispatcher = new Dispatcher(log);
    const notifier = new MultiChannelNotifier(api.runtime, cfg, log);
    const metrics = buildMetrics(api.runtime, log);
    const scheduler = new Scheduler(
      cfg,
      store,
      dispatcher,
      notifier,
      log,
      metrics,
      async (task) => {
        // Task chaining: dispatch a follow-up slash command if configured.
        const follow =
          (task.status === "done" && task.onDone) ||
          ((task.status === "failed" || task.status === "capped") && task.onFail) ||
          undefined;
        if (!follow || !follow.trim()) return;
        try {
          const args = follow.trim().replace(/^\/automode\s+/, "");
          await runAutomodeCommand(
            scheduler,
            { args, channel: task.telegram?.chatId },
            cfg,
            log,
            prefs,
            templates,
          );
        } catch (e) {
          log.warn(`[automode] chain ${task.id} → ${follow}: ${(e as Error).message}`);
        }
      },
    );
    const prefsSnapshot = prefs.get();
    if (prefsSnapshot.defaultAgent) {
      log.info(
        `[automode] sticky default agent from prefs: ${prefsSnapshot.defaultAgent}${prefsSnapshot.defaultBackend ? ` (backend=${prefsSnapshot.defaultBackend})` : ""}`,
      );
    }
    if (cfg.autonomy === "super-yolo" || prefsSnapshot.autonomy === "super-yolo") {
      log.warn(
        "[automode] 🚨 SUPER-YOLO autonomy is the default for this host. All tool guards (allowlist, denylist, path-scope) are DISABLED for every task until changed.",
      );
    }

    log.info(
      `[automode] loading (backend=${cfg.backend}, defaultAgent=${cfg.defaultAgent}, stateDir=${cfg.stateDir})`,
    );

    // 1) Lifecycle service: starts scheduler, resumes running tasks, drains on stop.
    //    The preflight runs once, async, so first-time SDK errors are visible
    //    in the log rather than deferred to the first /automode call.
    api.registerService?.({
      id: "automode.scheduler",
      start: () => {
        scheduler.start();
        sdkPreflight(log).catch(() => undefined);
      },
      stop: async () => {
        await scheduler.stop();
      },
    });

    // 2) Slash command: /automode <subcmd> <args>
    api.registerCommand?.({
      name: "automode",
      description: "Autonomous focus mode — run a goal to completion",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        try {
          return await runAutomodeCommand(scheduler, ctx, cfg, log, prefs, templates);
        } catch (e) {
          log.error(`[automode] command failed: ${(e as Error).message}`);
          return { text: `automode error: ${(e as Error).message}` };
        }
      },
    });

    // 3) CLI: `openclaw automode ...`
    api.registerCli?.(
      ({ program }) => {
        type Cmd = {
          command: (name: string) => Cmd;
          description: (d: string) => Cmd;
          argument: (name: string, desc?: string) => Cmd;
          option: (flags: string, desc?: string) => Cmd;
          action: (fn: (...args: unknown[]) => Promise<void> | void) => Cmd;
        };
        const p = program as unknown as Cmd;
        const auto = p.command("automode").description("automode task runner");
        auto
          .command("list")
          .description("list tasks")
          .action(() => {
            const list = scheduler.list();
            if (list.length === 0) {
              console.log("No automode tasks.");
              return;
            }
            for (const s of list) {
              console.log(
                `${s.id}  ${s.status.padEnd(10)}  turn ${s.turnCount}/${s.caps.maxTurns}  ${s.goal.slice(0, 80)}`,
              );
            }
          });
        auto
          .command("stop")
          .description("stop a task")
          .argument("<id>")
          .action(async (...args) => {
            const id = String(args[0]);
            const ok = await scheduler.stopTask(id, "cli");
            console.log(ok ? `stopped ${id}` : `no task ${id}`);
          });
        auto
          .command("inspect")
          .description("inspect a task")
          .argument("<id>")
          .action((...args) => {
            const id = String(args[0]);
            const s = scheduler.get(id);
            if (!s) {
              console.log(`no task ${id}`);
              return;
            }
            console.log(JSON.stringify(s, null, 2));
          });
        auto
          .command("start")
          .description("start a task")
          .argument("<goal...>")
          .option("--plan", "plan-first mode")
          .option("--agent <id>", "override agent")
          .option("--backend <id>", "override backend (acpx|claude-acp)")
          .option("--autonomy <level>", "strict|normal|high|yolo|super-yolo")
          .option("--dry-run", "simulate; no tools execute")
          .option("--verbose <n>", "verbosity 0-3")
          .option("--budget <usd>", "cost cap in USD (this task only)")
          .action(async (...args) => {
            const goalArg = args[0] as unknown;
            const opts = (args[1] ?? {}) as {
              plan?: boolean;
              agent?: string;
              backend?: string;
              autonomy?: string;
              dryRun?: boolean;
              verbose?: string;
              budget?: string;
            };
            const goal = Array.isArray(goalArg) ? goalArg.join(" ") : String(goalArg);
            const vl =
              opts.verbose !== undefined ? Math.min(3, Math.max(0, Math.floor(Number(opts.verbose)))) : undefined;
            const budget = opts.budget !== undefined ? Number(opts.budget) : undefined;
            const state = await scheduler.startTask({
              goal,
              mode: "hybrid",
              planFirst: Boolean(opts.plan),
              agent: opts.agent,
              backend: opts.backend === "acpx" || opts.backend === "claude-acp" ? opts.backend : undefined,
              autonomy: opts.autonomy as "strict" | "normal" | "high" | "yolo" | "super-yolo" | undefined,
              verbosity: vl as 0 | 1 | 2 | 3 | undefined,
              maxCostUsd: Number.isFinite(budget) && budget !== undefined ? budget : undefined,
              dryRun: Boolean(opts.dryRun),
            });
            console.log(`started ${state.id}${state.dryRun ? " (dry-run)" : ""}`);
          });
        auto
          .command("help")
          .description("show /automode help")
          .action(() => {
            console.log(helpText());
          });
      },
      { commands: ["automode"] },
    );

    // 4) Safety Layer 2: observe all tool calls (informational).
    api.on?.(
      "before_tool_call",
      (event, _ctx) => {
        try {
          const e = event as { taskId?: string; tool?: string; name?: string; command?: string; input?: Record<string, unknown> };
          const tool = e.tool ?? e.name ?? "";
          const command =
            e.command ??
            (typeof e.input?.command === "string" ? (e.input.command as string) : undefined);
          scheduler.observeToolCall({
            taskId: e.taskId,
            tool,
            command,
          });
        } catch (err) {
          log.warn(`[automode] before_tool_call observer failed: ${(err as Error).message}`);
        }
        return undefined;
      },
      { priority: 10 },
    );

    // 5) HTTP route for Telegram button callbacks.
    api.registerHttpRoute?.({
      path: "/automode/cb",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        try {
          const r = req as { method?: string; body?: unknown; url?: string };
          const w = res as { statusCode: number; setHeader: (k: string, v: string) => void; end: (b?: string) => void };
          let data = "";
          if (typeof r.body === "string") data = r.body;
          else if (r.body && typeof r.body === "object") {
            const b = r.body as { data?: unknown };
            if (typeof b.data === "string") data = b.data;
          }
          if (!data && typeof r.url === "string") {
            const q = r.url.split("?")[1] ?? "";
            const params = new URLSearchParams(q);
            data = params.get("data") ?? "";
          }
          const result = await handleCallback(scheduler, data, log);
          w.statusCode = result.ok ? 200 : 400;
          w.setHeader("Content-Type", "application/json");
          w.end(JSON.stringify(result));
          return true;
        } catch (e) {
          log.warn(`[automode] callback handler crashed: ${(e as Error).message}`);
          return true;
        }
      },
    });

    log.info(`[automode] ready (${scheduler.list().length} persisted task(s) on disk)`);
  },
};

// Exported for tests.
export { parseToolCallText };
