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
import { shouldRouteToAutomode } from "./src/engine/default-mode.js";
import { renderDashboard } from "./src/dashboard/html.js";
import { buildMenu, parseMenuData, type MenuPage } from "./src/telegram/menu.js";
import { parseAutonomyLevel } from "./src/engine/autonomy.js";

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
          const raw = (ctx.args ?? "").trim();
          // Bare `/automode` (or `/automode menu`) on Telegram: send the
          // inline-keyboard menu. Non-Telegram channels fall through to the
          // regular command flow (which returns help text for empty args).
          if ((raw === "" || raw.toLowerCase() === "menu") && ctx.channel === "telegram") {
            const sent = await sendMenuToTelegram(notifier, cfg, ctx, "root", scheduler, prefs, log);
            return { text: sent ? "" : "automode menu unavailable on this chat" };
          }
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

    // 4.4) DIAG — gated behind AUTOMODE_DEBUG env. Mirrors every hook so we can
    // see what OpenClaw hands us when a Telegram button is tapped.
    const DEBUG = process.env.AUTOMODE_DEBUG === "1" || process.env.AUTOMODE_DEBUG === "true";
    const diag = DEBUG
      ? (tag: string, event: unknown, hctx: unknown) => {
          try {
            const e = event as Record<string, unknown>;
            const c = hctx as Record<string, unknown>;
            const promptStr = typeof e?.prompt === "string" ? (e.prompt as string) : undefined;
            const contentStr = typeof e?.content === "string" ? (e.content as string) : undefined;
            const textStr = typeof e?.text === "string" ? (e.text as string) : undefined;
            const eventKeys = Object.keys(e ?? {}).join(",");
            const hasMenuCb =
              (promptStr && /automode:menu:/i.test(promptStr)) ||
              (contentStr && /automode:menu:/i.test(contentStr)) ||
              (textStr && /automode:menu:/i.test(textStr));
            const ctxDump = Object.entries(c ?? {})
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => `${k}=${String(v).slice(0, 120)}`)
              .join(" | ");
            log.info(
              `[automode:DIAG] ${tag}${hasMenuCb ? " [MENU-CB]" : ""} eventKeys=[${eventKeys}] ctx{${ctxDump}} ` +
                (promptStr !== undefined ? `prompt="${promptStr.slice(0, 300)}" ` : "") +
                (contentStr !== undefined ? `content="${contentStr.slice(0, 300)}" ` : "") +
                (textStr !== undefined ? `text="${textStr.slice(0, 200)}" ` : ""),
            );
          } catch {
            // ignore
          }
        }
      : () => undefined;
    // message_received sees the clean callback content BEFORE it's wrapped
    // in an agent envelope. Can't suppress the agent from here (void return),
    // but we CAN send the submenu / mutate prefs proactively. The
    // before_agent_start branch below still fires to steer the agent's
    // own one-liner reply.
    api.on?.("message_received", async (ev, c) => {
      diag("message_received", ev, c);
      try {
        const e = ev as { content?: string };
        const content = (e.content ?? "").trim();
        if (!content.startsWith("automode:menu:")) return;
        const payload = parseMenuData(content);
        if (!payload) return;
        const sdk = await notifier.getSdk();
        const chatId = extractHookChatId(c, cfg.telegram.chatId);
        if (!sdk || !chatId) {
          log.warn(
            `[automode] message_received menu-cb: cannot reply (sdk=${!!sdk}, chatId=${chatId ?? "null"})`,
          );
          return;
        }
        if (payload.kind === "nav") {
          const menu = buildMenu(
            payload.page as MenuPage,
            scheduler,
            cfg,
            prefs,
            payload.arg,
            templates,
          );
          await sdk.sendMessage(chatId, menu.text, {
            accountId: cfg.telegram.accountId,
            textMode: "markdown",
            buttons: menu.buttons,
          }).catch((err) => log.warn(`[automode] submenu send failed: ${(err as Error).message}`));
          return;
        }
        // Leaf action: prefs setters OR task-control actions.
        const { action, arg } = payload;
        if (action === "noop") return; // e.g. page-counter button
        if (action === "tplhint") {
          const hint = templateHint(arg);
          await sdk.sendMessage(chatId, hint, {
            accountId: cfg.telegram.accountId,
            textMode: "markdown",
          }).catch((err) => log.warn(`[automode] tplhint send failed: ${(err as Error).message}`));
          return;
        }
        let note = "";
        let afterPage: MenuPage | "task" = "root";
        let afterPageArg: string | undefined;
        if (action === "autonomy" && arg) {
          const level = parseAutonomyLevel(arg);
          if (level) {
            prefs.set({ autonomy: level });
            note = `✅ autonomy → ${level}`;
          }
        } else if (action === "budget" && arg !== undefined) {
          const n = Number(arg);
          if (Number.isFinite(n) && n >= 0) {
            prefs.set({ budgetUsd: n });
            note = n > 0 ? `✅ budget → $${n.toFixed(2)}` : "✅ budget → disabled";
          }
        } else if (action === "verbose" && arg !== undefined) {
          const n = Number(arg);
          if (Number.isFinite(n) && n >= 0 && n <= 3) {
            prefs.set({ verbosity: Math.floor(n) as 0 | 1 | 2 | 3 });
            note = `✅ verbosity → ${Math.floor(n)}`;
          }
        } else if (action === "inspect" && arg) {
          note = "";
          afterPage = "task";
          afterPageArg = arg;
        } else if (action === "tail" && arg) {
          // Claim the progress message for this task: future turn-end progress
          // updates will edit messages in this chat. The current inspect
          // message becomes the dashboard once we rebuild it in task mode.
          scheduler.setTail(arg, true);
          note = "📡 Tailing — live updates will edit this thread.";
          afterPage = "task";
          afterPageArg = arg;
        } else if (action === "untail" && arg) {
          scheduler.setTail(arg, false);
          note = "🛑 Stopped tailing.";
          afterPage = "task";
          afterPageArg = arg;
        } else if (action === "taskpause" && arg) {
          const r = await scheduler.pauseTask(arg);
          note = r.ok ? "⏸ Paused." : `⚠️ ${r.error ?? "pause failed"}`;
          afterPage = "task";
          afterPageArg = arg;
        } else if (action === "taskresume" && arg) {
          const r = await scheduler.resumeTask(arg);
          note = r.ok ? "▶️ Resumed." : `⚠️ ${r.error ?? "resume failed"}`;
          afterPage = "task";
          afterPageArg = arg;
        } else if (action === "taskstop" && arg) {
          const r = await scheduler.stopTask(arg, "user (menu)");
          note = r.ok ? "⏹ Stopped." : `⚠️ ${r.error ?? "stop failed"}`;
          afterPage = "tasks";
        } else if (
          action === "doctor" ||
          action === "help" ||
          action === "defaults" ||
          action === "templates" ||
          action === "ledger" ||
          action === "status"
        ) {
          // Execute the real slash-command inline and stream the result
          // back to this chat. No prefs/state change -> no follow-up menu.
          try {
            const commandArgs = action === "status" ? "status" : action;
            const result = await runAutomodeCommand(
              scheduler,
              { args: commandArgs, channel: "telegram", senderId: chatId },
              cfg,
              log,
              prefs,
              templates,
            );
            const body = result?.text ?? `(no output for ${action})`;
            // Telegram message limit is 4096; trim to stay well clear and
            // wrap in a code fence so leading `>` or `*` doesn't break parse.
            const clipped = body.length > 3500 ? body.slice(0, 3497) + "…" : body;
            await sdk.sendMessage(chatId, "```\n" + clipped + "\n```", {
              accountId: cfg.telegram.accountId,
              textMode: "markdown",
            }).catch((err) => log.warn(`[automode] ${action} send failed: ${(err as Error).message}`));
          } catch (err) {
            log.warn(`[automode] ${action} inline exec failed: ${(err as Error).message}`);
            await sdk.sendMessage(chatId, `⚠️ ${action} failed: ${(err as Error).message}`, {
              accountId: cfg.telegram.accountId,
            }).catch(() => undefined);
          }
          return;
        }
        if (note) {
          const menu = buildMenu(afterPage as MenuPage, scheduler, cfg, prefs, afterPageArg);
          await sdk.sendMessage(chatId, `${note}\n\n${menu.text}`, {
            accountId: cfg.telegram.accountId,
            textMode: "markdown",
            buttons: menu.buttons,
          }).catch((err) => log.warn(`[automode] post-action re-render failed: ${(err as Error).message}`));
        } else if (action === "inspect" && arg) {
          const menu = buildMenu("task", scheduler, cfg, prefs, arg);
          await sdk.sendMessage(chatId, menu.text, {
            accountId: cfg.telegram.accountId,
            textMode: "markdown",
            buttons: menu.buttons,
          }).catch((err) => log.warn(`[automode] inspect send failed: ${(err as Error).message}`));
        }
      } catch (err) {
        log.warn(`[automode] message_received menu-cb error: ${(err as Error).message}`);
      }
    });
    api.on?.("before_prompt_build", (ev, c) => {
      diag("before_prompt_build", ev, c);
      return undefined;
    });

    // 4.5) before_agent_start interceptor. Two responsibilities:
    //   (a) Menu callback_data (automode:menu:…): OpenClaw's Telegram plugin
    //       dispatches button taps into the agent pipeline as inbound text.
    //       We recognise our namespace, handle it (mutate prefs, send a
    //       submenu or confirmation), and return a systemPrompt that makes
    //       the agent send a 1-line ACK so we don't burn tokens.
    //   (b) Default-to-automode routing: if enabled for this chat and the
    //       message passes the heuristic gate, spawn a task and ACK.
    api.on?.("before_agent_start", async (event, hctx) => {
      diag("before_agent_start", event, hctx);
      try {
        const hookEvent = event as { prompt?: string };
        const ctxObj = hctx as { channel?: string; senderId?: string; chatId?: string };
        const chatId = extractHookChatId(hctx, cfg.telegram.chatId);
        const prompt = (hookEvent.prompt ?? "").trim();

        // (a) Menu callback interception.
        //
        //     The actual UI work (sending submenus, mutating prefs, re-rendering
        //     the root menu) is done in the `message_received` hook above
        //     because it sees the clean callback_data BEFORE the inbound
        //     envelope is applied. This branch only produces a systemPrompt
        //     so the agent's own reply stays minimal — for nav/setter, a
        //     single bullet to confirm; for leaf info actions, the hint.
        //
        //     The raw callback is wrapped by OpenClaw's inbound envelope
        //     ("Conversation info (untrusted metadata):\n...\nautomode:menu:X\n...").
        //     Match the token anywhere.
        const menuMatch = prompt.match(/automode:menu:[A-Za-z0-9:_\-]+/);
        if (menuMatch) {
          const payload = parseMenuData(menuMatch[0]);
          if (payload) {
            log.info(`[automode] menu callback (agent ack only): ${menuMatch[0]}`);
            let ack = "·";
            if (payload.kind === "action") {
              const hints: Record<string, string> = {
                status: "Use /automode status for the live list.",
                help: "Use /automode help for the full command list.",
                doctor: "Use /automode doctor for SDK + agent diagnostics.",
                defaults: "Use /automode defaults for sticky prefs.",
                templates: "Use /automode templates (list) or /automode template <name>.",
                ledger: "Use /automode ledger [day|week|month|all].",
                newtask: "Send /automode <goal> to start. Add -y for yolo or --dry-run to simulate.",
              };
              // For setter / task-control actions the message_received
              // handler already sent the UI; a tiny bullet here keeps the
              // thread clean and stops the LLM from hallucinating callback_data.
              const settlers = new Set([
                "autonomy",
                "budget",
                "verbose",
                "inspect",
                "tail",
                "untail",
                "taskpause",
                "taskresume",
                "taskstop",
                "noop",
                // Doctor/Help/Defaults/Templates/Ledger/Status are executed
                // inline in message_received; the agent should just emit a
                // tiny ack so the LLM doesn't hallucinate a hint reply.
                "doctor",
                "help",
                "defaults",
                "templates",
                "ledger",
                "status",
                "tplhint",
              ]);
              if (settlers.has(payload.action)) {
                ack = "·";
              } else if (hints[payload.action]) {
                ack = hints[payload.action]!;
              }
            }
            return {
              systemPrompt:
                `Reply with exactly one line and nothing else:\n${ack}\nDo not elaborate. Do not explain the callback_data format.`,
            };
          }
        }

        // (b) Default-to-automode routing.
        const decision = shouldRouteToAutomode(prompt, chatId, cfg, prefs);
        if (!decision.route) return undefined;
        const state = await scheduler.startTask({
          goal: prompt,
          mode: "hybrid",
          chatId,
          owner: ctxObj.senderId || ctxObj.channel
            ? { channel: ctxObj.channel, senderId: ctxObj.senderId }
            : undefined,
        });
        log.info(`[automode] default-mode routed message to task ${state.id} (${decision.reason})`);
        return {
          systemPrompt:
            `You are a message router. Respond with exactly one line:\n` +
            `🤖 Routed to automode task ${state.id}. Watch progress in this chat.\n` +
            `Do not attempt to answer the user's request — it is being handled autonomously.`,
        };
      } catch (err) {
        log.warn(`[automode] before_agent_start hook error: ${(err as Error).message}`);
        return undefined;
      }
    });

    // 5) HTTP route for Telegram button callbacks — handles both escalation
    // decisions and menu-button taps.
    api.registerHttpRoute?.({
      path: "/automode/cb",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        try {
          const r = req as { method?: string; body?: unknown; url?: string };
          const w = res as { statusCode: number; setHeader: (k: string, v: string) => void; end: (b?: string) => void };
          let data = "";
          let fromChatId: string | undefined;
          let fromMessageId: number | undefined;
          if (typeof r.body === "string") data = r.body;
          else if (r.body && typeof r.body === "object") {
            const b = r.body as { data?: unknown; chatId?: unknown; messageId?: unknown };
            if (typeof b.data === "string") data = b.data;
            if (typeof b.chatId === "string") fromChatId = b.chatId;
            if (typeof b.messageId === "number") fromMessageId = b.messageId;
          }
          if (!data && typeof r.url === "string") {
            const q = r.url.split("?")[1] ?? "";
            const params = new URLSearchParams(q);
            data = params.get("data") ?? "";
          }

          // Menu callbacks first (different namespace than escalations).
          const menuPayload = parseMenuData(data);
          if (menuPayload) {
            const result = await handleMenuCallback(
              menuPayload,
              scheduler,
              cfg,
              prefs,
              notifier,
              fromChatId,
              fromMessageId,
              log,
              templates,
            );
            w.statusCode = 200;
            w.setHeader("Content-Type", "application/json");
            w.end(JSON.stringify(result));
            return true;
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

    // 6) Web dashboard — GET /automode/ui renders a single HTML page.
    api.registerHttpRoute?.({
      path: "/automode/ui",
      auth: "gateway",
      match: "exact",
      handler: async (_req, res) => {
        try {
          const w = res as {
            statusCode: number;
            setHeader: (k: string, v: string) => void;
            end: (b?: string) => void;
          };
          const html = renderDashboard(scheduler.list());
          w.statusCode = 200;
          w.setHeader("Content-Type", "text/html; charset=utf-8");
          w.setHeader("Cache-Control", "no-store");
          w.end(html);
          return true;
        } catch (e) {
          log.warn(`[automode] /automode/ui handler error: ${(e as Error).message}`);
          return true;
        }
      },
    });

    log.info(`[automode] ready (${scheduler.list().length} persisted task(s) on disk)`);
  },
};

function resolveChatId(ctx: { channel?: string; senderId?: string }, cfgChatId: string | undefined): string | undefined {
  if (ctx.channel === "telegram" && ctx.senderId) return `telegram:${ctx.senderId}`;
  if (ctx.channel && ctx.channel.includes(":")) return ctx.channel;
  return cfgChatId;
}

/**
 * Extract a telegram chat id from the hook context. OpenClaw doesn't give us
 * `senderId` directly — the telegram target lives inside `sessionKey`,
 * `conversationId`, or `channelId`. Known formats:
 *   agent:<agentId>:telegram:direct:<senderId>
 *   agent:<agentId>:telegram:group:<chatId>[:topic:<n>]
 *   telegram:<id>             (already namespaced)
 *   -100…                     (bare numeric chat id)
 */
function extractHookChatId(hctx: unknown, cfgChatId: string | undefined): string | undefined {
  const h = hctx as Record<string, unknown> | undefined;
  if (!h) return cfgChatId;
  const candidates: string[] = [];
  for (const k of ["sessionKey", "channelId", "sessionId", "conversationId", "chatId"]) {
    const v = h[k];
    if (typeof v === "string" && v) candidates.push(v);
  }
  // Nested `from.id` / `from.userId` on message_received.
  const fromObj = h.from as Record<string, unknown> | undefined;
  if (fromObj) {
    for (const k of ["id", "userId", "chatId"]) {
      const v = fromObj[k];
      if (typeof v === "string" && v) candidates.push(v);
      if (typeof v === "number" && Number.isFinite(v)) candidates.push(String(v));
    }
  }
  for (const raw of candidates) {
    const m1 = raw.match(/\btelegram:(?:direct|group):(-?\d+)/);
    if (m1) return `telegram:${m1[1]}`;
    const m2 = raw.match(/^telegram:(-?\d+)(?::|$)/);
    if (m2) return `telegram:${m2[1]}`;
    // Bare numeric id (rare but possible on some ctxs)
    if (/^-?\d{5,}$/.test(raw)) return `telegram:${raw}`;
  }
  return cfgChatId;
}

type MenuLog = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

async function sendMenuToTelegram(
  notifier: MultiChannelNotifier,
  cfg: Parameters<typeof buildMenu>[2],
  ctx: { channel?: string; senderId?: string },
  page: MenuPage,
  scheduler: Parameters<typeof buildMenu>[1],
  prefs: Parameters<typeof buildMenu>[3],
  log: MenuLog,
): Promise<boolean> {
  const sdk = await notifier.getSdk();
  if (!sdk) return false;
  const chatId = resolveChatId(ctx, cfg.telegram.chatId);
  if (!chatId) return false;
  const menu = buildMenu(page, scheduler, cfg, prefs);
  try {
    await sdk.sendMessage(chatId, menu.text, {
      accountId: cfg.telegram.accountId,
      textMode: "markdown",
      buttons: menu.buttons,
    });
    return true;
  } catch (e) {
    log.warn(`[automode] menu send failed: ${(e as Error).message}`);
    return false;
  }
}

async function handleMenuCallback(
  payload: ReturnType<typeof parseMenuData>,
  scheduler: Parameters<typeof buildMenu>[1],
  cfg: Parameters<typeof buildMenu>[2],
  prefs: Parameters<typeof buildMenu>[3],
  notifier: MultiChannelNotifier,
  chatId: string | undefined,
  messageId: number | undefined,
  log: MenuLog,
  templates: Parameters<typeof runAutomodeCommand>[5],
): Promise<{ ok: boolean; text: string }> {
  if (!payload) return { ok: false, text: "invalid menu payload" };
  const sdk = await notifier.getSdk();
  const effectiveChatId = chatId ?? cfg.telegram.chatId;

  if (payload.kind === "nav") {
    if (!sdk || !effectiveChatId || !messageId) {
      return { ok: false, text: "cannot edit menu message (missing sdk / chatId / messageId)" };
    }
    const menu = buildMenu(payload.page as MenuPage, scheduler, cfg, prefs, payload.arg, templates);
    try {
      await sdk.editMessage(effectiveChatId, messageId, menu.text, {
        accountId: cfg.telegram.accountId,
        textMode: "markdown",
        buttons: menu.buttons,
      });
      return { ok: true, text: `nav → ${payload.page}${payload.arg ? `:${payload.arg}` : ""}` };
    } catch (e) {
      log.warn(`[automode] menu nav edit failed: ${(e as Error).message}`);
      return { ok: false, text: (e as Error).message };
    }
  }

  const { action, arg } = payload;
  switch (action) {
    case "noop":
      return { ok: true, text: "noop" };
    case "inspect": {
      if (!arg) return { ok: false, text: "inspect requires a task id" };
      return rerenderPage(sdk, effectiveChatId, messageId, cfg, scheduler, prefs, log, "task", arg);
    }
    case "tail": {
      if (!arg) return { ok: false, text: "tail requires a task id" };
      if (effectiveChatId && messageId) {
        scheduler.setProgressMessage(arg, effectiveChatId, messageId);
      }
      scheduler.setTail(arg, true);
      return rerenderPage(sdk, effectiveChatId, messageId, cfg, scheduler, prefs, log, "task", arg);
    }
    case "untail": {
      if (!arg) return { ok: false, text: "untail requires a task id" };
      scheduler.setTail(arg, false);
      return rerenderPage(sdk, effectiveChatId, messageId, cfg, scheduler, prefs, log, "task", arg);
    }
    case "taskpause": {
      if (!arg) return { ok: false, text: "pause requires a task id" };
      await scheduler.pauseTask(arg);
      return rerenderPage(sdk, effectiveChatId, messageId, cfg, scheduler, prefs, log, "task", arg);
    }
    case "taskresume": {
      if (!arg) return { ok: false, text: "resume requires a task id" };
      await scheduler.resumeTask(arg);
      return rerenderPage(sdk, effectiveChatId, messageId, cfg, scheduler, prefs, log, "task", arg);
    }
    case "taskstop": {
      if (!arg) return { ok: false, text: "stop requires a task id" };
      await scheduler.stopTask(arg, "user (menu)");
      return rerenderPage(sdk, effectiveChatId, messageId, cfg, scheduler, prefs, log, "tasks");
    }
    case "status":
    case "help":
    case "doctor":
    case "defaults":
    case "templates":
    case "ledger":
    case "newtask": {
      // newtask still needs text input -> keep as a hint.
      if (action === "newtask") {
        const hint = "Send `/automode <your goal>` to start a task. Or `/automode -y <goal>` for yolo, `/automode --dry-run <goal>` to simulate.";
        if (sdk && effectiveChatId) {
          await sdk.sendMessage(effectiveChatId, hint, {
            accountId: cfg.telegram.accountId,
            textMode: "markdown",
          }).catch(() => undefined);
        }
        return { ok: true, text: hint };
      }
      // Inline-execute the real slash-command handler and stream the
      // result. This keeps the menu button and the /automode subcommand
      // strictly equivalent.
      const commandArgs = action === "status" ? "status" : action;
      try {
        const result = await runAutomodeCommand(
          scheduler,
          { args: commandArgs, channel: "telegram", senderId: effectiveChatId },
          cfg,
          log,
          prefs,
          templates,
        );
        const body = result?.text ?? `(no output for ${action})`;
        const clipped = body.length > 3500 ? body.slice(0, 3497) + "…" : body;
        if (sdk && effectiveChatId) {
          await sdk.sendMessage(effectiveChatId, "```\n" + clipped + "\n```", {
            accountId: cfg.telegram.accountId,
            textMode: "markdown",
          }).catch(() => undefined);
        }
        return { ok: true, text: `ran ${action}` };
      } catch (e) {
        log.warn(`[automode] ${action} inline exec failed: ${(e as Error).message}`);
        return { ok: false, text: (e as Error).message };
      }
    }
    case "autonomy": {
      const level = parseAutonomyLevel(arg ?? "");
      if (!level) return { ok: false, text: "invalid autonomy level" };
      prefs?.set({ autonomy: level });
      return rerenderRoot(sdk, effectiveChatId, messageId, cfg, scheduler, prefs, log, `autonomy → ${level}`);
    }
    case "budget": {
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 0) return { ok: false, text: "invalid budget" };
      prefs?.set({ budgetUsd: n });
      return rerenderRoot(sdk, effectiveChatId, messageId, cfg, scheduler, prefs, log, `budget → $${n.toFixed(2)}`);
    }
    case "verbose": {
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 0 || n > 3) return { ok: false, text: "invalid verbosity" };
      prefs?.set({ verbosity: Math.floor(n) as 0 | 1 | 2 | 3 });
      return rerenderRoot(sdk, effectiveChatId, messageId, cfg, scheduler, prefs, log, `verbosity → ${n}`);
    }
    default:
      return { ok: false, text: `unknown menu action: ${action}` };
  }
}

async function rerenderRoot(
  sdk: Awaited<ReturnType<MultiChannelNotifier["getSdk"]>>,
  chatId: string | undefined,
  messageId: number | undefined,
  cfg: Parameters<typeof buildMenu>[2],
  scheduler: Parameters<typeof buildMenu>[1],
  prefs: Parameters<typeof buildMenu>[3],
  log: MenuLog,
  note: string,
): Promise<{ ok: boolean; text: string }> {
  return rerenderPage(sdk, chatId, messageId, cfg, scheduler, prefs, log, "root", undefined, note);
}

async function rerenderPage(
  sdk: Awaited<ReturnType<MultiChannelNotifier["getSdk"]>>,
  chatId: string | undefined,
  messageId: number | undefined,
  cfg: Parameters<typeof buildMenu>[2],
  scheduler: Parameters<typeof buildMenu>[1],
  prefs: Parameters<typeof buildMenu>[3],
  log: MenuLog,
  page: MenuPage,
  pageArg?: string,
  note?: string,
): Promise<{ ok: boolean; text: string }> {
  if (!sdk || !chatId || !messageId) {
    return { ok: true, text: note ?? `nav → ${page}` };
  }
  const menu = buildMenu(page, scheduler, cfg, prefs, pageArg);
  try {
    await sdk.editMessage(chatId, messageId, menu.text, {
      accountId: cfg.telegram.accountId,
      textMode: "markdown",
      buttons: menu.buttons,
    });
  } catch (e) {
    log.warn(`[automode] menu rerender failed: ${(e as Error).message}`);
  }
  return { ok: true, text: note ?? `nav → ${page}` };
}

/**
 * Hint messages for the ➕/✏️/🗑/📋 buttons on the Templates menu. The
 * buttons themselves don't mutate state; they explain the slash command
 * the user should type. This is deliberate: Telegram inline keyboards
 * can't accept text input, so template names + field values come in via
 * the slash channel where we get proper audit + validation.
 */
function templateHint(action: string | undefined): string {
  switch (action) {
    case "new":
      return [
        "➕  *Create a template*",
        "",
        "`/automode template-new <name>`",
        "",
        "Then populate fields one at a time:",
        "`/automode template-set <name> <field> <value>`",
        "",
        "Fields: description, goalTemplate, agent, autonomy, maxTurns, maxCostUsd, verbosity, onDone, onFail",
      ].join("\n");
    case "edit":
      return [
        "✏️  *Edit a template*",
        "",
        "`/automode template-set <name> <field> <value>`",
        "",
        "Examples:",
        '`/automode template-set mine goalTemplate "fix failing tests in {{arg}}"`',
        "`/automode template-set mine autonomy high`",
        "`/automode template-set mine maxCostUsd 2`",
        "",
        "Built-ins are read-only. Clone one first:",
        "`/automode template-clone <builtin>`",
      ].join("\n");
    case "clone":
      return [
        "📋  *Clone a built-in*",
        "",
        "`/automode template-clone <builtin> [new-name]`",
        "",
        "Omit `new-name` to shadow the built-in with your own copy.",
        "Example: `/automode template-clone fix-tests mine-fix`",
      ].join("\n");
    case "delete":
      return [
        "🗑  *Delete a user template*",
        "",
        "`/automode template-delete <name>`",
        "",
        "Built-ins cannot be deleted — they're frozen.",
      ].join("\n");
    default:
      return "Unknown template action. Open the Templates menu to see options.";
  }
}

// Exported for tests.
export { parseToolCallText };
