import fs from "node:fs";
import path from "node:path";
import type { Scheduler } from "./engine/scheduler.js";
import { sdkPreflight } from "./agents/dispatcher.js";
import { findOpenclawRoots } from "./agents/sdk-loader.js";
import { Preferences, inferBackend } from "./engine/preferences.js";
import { parseFlags } from "./flags.js";
import { renderGoal, EDITABLE_FIELDS, type TemplateStore } from "./engine/templates.js";

function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}
import { buildLedger, formatLedger, type LedgerWindow } from "./engine/ledger.js";
import { tailLogsForTask } from "./engine/logs.js";
import type {
  AutomodeConfig,
  AutonomyLevel,
  StartOptions,
  TaskMode,
  TaskState,
  VerbosityLevel,
} from "./types.js";
import { parseAutonomyLevel } from "./engine/autonomy.js";

export type CommandCtx = {
  senderId?: string;
  channel?: string;
  isAuthorizedSender?: boolean;
  args?: string;
  commandBody?: string;
};

export type CommandResult = { text: string };

const INTERVAL_RE = /^\s*(\d+)(s|sec|seconds|m|min|minutes|h|hr|hours)\s+(.*)$/i;

function parseInterval(raw: string): { intervalSec: number; rest: string } | null {
  const m = raw.match(INTERVAL_RE);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const multiplier = unit.startsWith("h") ? 3600 : unit.startsWith("m") && unit !== "m" ? 60 : unit === "m" ? 60 : 1;
  return { intervalSec: n * multiplier, rest: (m[3] ?? "").trim() };
}

function fmtTaskRow(s: TaskState): string {
  const age = Math.round((Date.now() - s.createdAt) / 1000);
  return `- \`${s.id}\`  ${s.status}  (mode ${s.mode}, turn ${s.turnCount}/${s.caps.maxTurns}, age ${age}s)\n  ${s.goal.slice(0, 80)}${s.goal.length > 80 ? "…" : ""}`;
}

type ResolvedTarget = {
  agent: string;
  backend: "acpx" | "claude-acp";
  source: { agent: "flag" | "prefs" | "config"; backend: "flag" | "prefs" | "infer" | "config" };
};

/**
 * Resolve the Telegram chat id to persist on the task.
 *
 * `CommandCtx.channel` from OpenClaw's command dispatch is a channel KIND
 * (`"telegram"`, `"slack"`, `"discord"`) — NOT a chat id. Storing it verbatim
 * made the notifier later try to `sendMessageTelegram("telegram", ...)` which
 * of course fails. Build a real addressable id here:
 *
 *  - kind-only channel (e.g. `"telegram"`) + senderId → `"telegram:<senderId>"`
 *  - already-namespaced channel (contains `:`) → use as-is
 *  - otherwise → fall back to the configured chatId
 *
 * Fix authored by the user; see CHANGELOG 0.3.3.
 */
function resolveTaskChatId(ctx: CommandCtx, cfg: AutomodeConfig): string | undefined {
  const channel = ctx.channel?.trim();
  const senderId = ctx.senderId?.trim();
  if (channel === "telegram" && senderId) return `telegram:${senderId}`;
  if (channel && channel.includes(":")) return channel;
  return cfg.telegram.chatId;
}

function buildInitWizard(cfg: AutomodeConfig, ctx: CommandCtx, prefs?: Preferences): string {
  const chatId = resolveTaskChatId(ctx, cfg);
  const suggestedAgent = cfg.discoveredAcpxAgents[0] ?? "auto";
  const suggestedAutonomy = cfg.discoveredAcpxAgents.length === 0 ? "strict" : "normal";
  const lines: string[] = [
    "# /automode init — host setup snapshot",
    "",
    `## Discovered on this host`,
    `• acpx agents:       [${cfg.discoveredAcpxAgents.join(", ") || "(none — configure plugins.entries.acpx.config.agents)"}]`,
    `• caller channel:    ${ctx.channel ?? "(unknown)"}${ctx.senderId ? ` / sender ${ctx.senderId}` : ""}`,
    `• resolved chatId:   ${chatId ?? "(none)"}`,
    ``,
    `## Suggested config block`,
    "Paste this into `plugins.entries.automode.config` in your `openclaw.json`:",
    "",
    "```json",
    JSON.stringify(
      {
        defaultAgent: suggestedAgent,
        backend: suggestedAgent.startsWith("claude") ? "claude-acp" : "acpx",
        autonomy: suggestedAutonomy,
        verbosity: 1,
        maxCostUsd: 5,
        maxTurns: 50,
        maxDurationSec: 3600,
        telegram: {
          enabled: Boolean(chatId),
          accountId: cfg.telegram.accountId ?? "default",
          ...(chatId ? { chatId } : {}),
        },
        defaultMode: {
          enabled: false,
          gate: "verbOrLength",
          minWords: 6,
        },
      },
      null,
      2,
    ),
    "```",
    "",
    `## Quick sticky setup (no restart needed)`,
    `  /automode use ${suggestedAgent}`,
    `  /automode autonomy ${suggestedAutonomy}`,
    `  /automode budget 5`,
    `  /automode verbose 1`,
    chatId ? `  /automode on         # enable default-mode for this chat` : "",
    ``,
    `## Validate`,
    `  /automode doctor`,
    `  /automode --dry-run "verify plugin boots"`,
  ];
  if (prefs) {
    const p = prefs.get();
    lines.push(
      "",
      "## Current sticky state (per-host)",
      `• agent:     ${p.defaultAgent ?? "(unset)"}`,
      `• backend:   ${p.defaultBackend ?? "(unset)"}`,
      `• autonomy:  ${p.autonomy ?? "(unset)"}`,
      `• budget:    ${p.budgetUsd ?? "(unset)"}`,
      `• verbosity: ${p.verbosity ?? "(unset)"}`,
    );
  }
  return lines.filter(Boolean).join("\n");
}

function tailTask(cfg: AutomodeConfig, args: string): string {
  const parts = args.split(/\s+/).filter(Boolean);
  const wantJson = parts.includes("--json");
  const clean = parts.filter((p) => !p.startsWith("--"));
  const id = clean[0];
  if (!id) return "Usage: /automode tail <id> [N] [--json]";
  const n = clean[1] ? Math.max(1, Math.min(50, Number(clean[1]) || 5)) : 5;
  const turnsDir = path.join(cfg.stateDir, "tasks", id, "turns");
  let files: string[];
  try {
    files = fs.existsSync(turnsDir) ? fs.readdirSync(turnsDir).sort() : [];
  } catch {
    return `no turns directory for ${id}`;
  }
  if (files.length === 0) return `no turns recorded for ${id}`;
  const recent = files.slice(-n);
  const records: Array<Record<string, unknown>> = [];
  for (const f of recent) {
    const file = path.join(turnsDir, f);
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      const first = raw.split("\n")[0] ?? "{}";
      records.push(JSON.parse(first) as Record<string, unknown>);
    } catch (e) {
      records.push({ file: f, parseError: (e as Error).message });
    }
  }
  if (wantJson) {
    return "```json\n" + JSON.stringify({ taskId: id, turns: records }, null, 2) + "\n```";
  }
  const blocks: string[] = [`# last ${records.length} turn(s) for ${id}`, ""];
  for (const rec of records) {
    const r = rec as {
      index?: number; agent?: string; backend?: string;
      startedAt?: number; endedAt?: number;
      error?: string;
      toolCalls?: Array<{ name: string; allowed?: boolean }>;
    };
    const dur = r.endedAt && r.startedAt ? ((r.endedAt - r.startedAt) / 1000).toFixed(1) : "?";
    const toolSummary = (r.toolCalls ?? [])
      .slice(-5)
      .map((t) => (t.allowed === false ? `🚫${t.name}` : t.name))
      .join(", ");
    blocks.push(
      `turn ${r.index ?? "?"} via ${r.agent ?? "?"}@${r.backend ?? "?"} · ${dur}s${r.error ? ` · ERROR: ${r.error.slice(0, 100)}` : ""}`,
      toolSummary ? `  tools: ${toolSummary}` : "  (no tool calls)",
    );
  }
  return blocks.join("\n");
}

function resolveTarget(
  flagAgent: string | undefined,
  flagBackend: string | undefined,
  cfg: AutomodeConfig,
  prefs: Preferences | undefined,
): ResolvedTarget {
  const p = prefs?.get() ?? {};
  const agent = flagAgent ?? p.defaultAgent ?? cfg.defaultAgent;
  const agentSource: ResolvedTarget["source"]["agent"] = flagAgent
    ? "flag"
    : p.defaultAgent
      ? "prefs"
      : "config";

  let backend: "acpx" | "claude-acp";
  let backendSource: ResolvedTarget["source"]["backend"];
  if (flagBackend === "acpx" || flagBackend === "claude-acp") {
    backend = flagBackend;
    backendSource = "flag";
  } else if (p.defaultBackend) {
    backend = p.defaultBackend;
    backendSource = "prefs";
  } else if (flagAgent || p.defaultAgent) {
    // When the agent was chosen explicitly (flag or prefs), auto-infer the
    // best backend rather than inheriting the plugin config (which may still
    // say claude-acp even though the user picked codex).
    backend = inferBackend(agent);
    backendSource = "infer";
  } else {
    backend = cfg.backend;
    backendSource = "config";
  }
  return { agent, backend, source: { agent: agentSource, backend: backendSource } };
}

async function handleStart(
  scheduler: Scheduler,
  mode: TaskMode,
  goal: string,
  ctx: CommandCtx,
  cfg: AutomodeConfig,
  prefs: Preferences | undefined,
  flags: ReturnType<typeof parseFlags>,
  intervalSec?: number,
  planFirstOverride = false,
): Promise<CommandResult> {
  if (!goal) return { text: "Usage: /automode <goal>. Type `/automode help` for details." };
  const target = resolveTarget(flags.agent, flags.backend, cfg, prefs);
  const verbosity =
    flags.verbosity ?? prefs?.get().verbosity ?? cfg.verbosity;
  const autonomy: AutonomyLevel =
    flags.autonomy ?? prefs?.get().autonomy ?? cfg.autonomy;
  const maxCostUsd =
    flags.budgetUsd ?? prefs?.get().budgetUsd ?? cfg.maxCostUsd;
  const opts: StartOptions = {
    goal,
    mode,
    planFirst: planFirstOverride || Boolean(flags.plan),
    intervalSec,
    agent: target.agent,
    backend: target.backend,
    maxTurns: flags.maxTurns,
    maxDurationSec: flags.maxDurationSec,
    maxCostUsd,
    verbosity,
    autonomy,
    dryRun: Boolean(flags.dryRun),
    onDone: flags.onDone,
    onFail: flags.onFail,
    chatId: resolveTaskChatId(ctx, cfg),
    owner: ctx.senderId || ctx.channel
      ? { channel: ctx.channel, senderId: ctx.senderId }
      : undefined,
  };
  const state = await scheduler.startTask(opts);
  const targetLine =
    target.source.agent === "config" && target.source.backend === "config"
      ? ""
      : `\nagent: ${target.agent} (${target.source.agent}), backend: ${target.backend} (${target.source.backend})`;
  return {
    text: `🚀 automode task started\nid: \`${state.id}\`\nmode: ${state.mode}${targetLine}\ngoal: ${state.goal.slice(0, 200)}`,
  };
}

export async function runAutomodeCommand(
  scheduler: Scheduler,
  ctx: CommandCtx,
  cfg?: AutomodeConfig,
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
  prefs?: Preferences,
  templates?: TemplateStore,
): Promise<CommandResult> {
  const raw = (ctx.args ?? "").trim();
  if (!raw || raw.toLowerCase() === "help") return { text: helpText() };

  // Peek at the first word to detect a non-goal subcommand. If it doesn't
  // match a known one, every token becomes input to the flag parser.
  const firstWord = raw.split(/\s+/)[0]?.toLowerCase() ?? "";
  const KNOWN = new Set([
    "help", "doctor", "diag", "diagnose", "init",
    "status", "ls", "list",
    "stop", "pause", "resume",
    "inspect", "show", "tail", "logs",
    "plan", "interval", "goal", "paced", "hybrid",
    "use", "defaults", "reset-defaults", "reset",
    "verbose", "verbosity",
    "autonomy", "yolo", "super-yolo", "unsafe",
    "template", "templates",
    "template-new", "template-set", "template-delete", "template-rm", "template-clone",
    "ledger", "cost",
    "shadow",
    "budget",
    "on", "off",
  ]);
  if (!KNOWN.has(firstWord)) {
    // Unknown first word → the whole args is a goal. Parse flags from full string.
    if (!cfg) return { text: "automode: config not provided; cannot start task" };
    const flags = parseFlags(raw);
    return handleStart(scheduler, "hybrid", flags.rest, ctx, cfg, prefs, flags);
  }

  // Known subcommand — slice off the first token and feed the rest to flag parser.
  const [first, ...rest] = raw.split(/\s+/);
  const afterSub = rest.join(" ").trim();
  const subFlags = parseFlags(afterSub);
  const tail = subFlags.rest;
  const sub = (first ?? "").toLowerCase();

  switch (sub) {
    case "doctor":
    case "diag":
    case "diagnose": {
      return { text: await doctor(cfg, logger, prefs) };
    }
    case "use": {
      if (!prefs) return { text: "preferences store unavailable" };
      if (!tail) {
        const p = prefs.get();
        return {
          text: [
            "Usage: /automode use <agent> [--backend=<acpx|claude-acp>]",
            `Current sticky default agent: ${p.defaultAgent ?? "(unset)"}`,
            `Current sticky default backend: ${p.defaultBackend ?? "(unset — auto-inferred from agent)"}`,
          ].join("\n"),
        };
      }
      const patch: { defaultAgent: string; defaultBackend?: "acpx" | "claude-acp" } = {
        defaultAgent: tail,
      };
      if (subFlags.backend === "acpx" || subFlags.backend === "claude-acp") {
        patch.defaultBackend = subFlags.backend;
      }
      prefs.set(patch);
      const resolved = inferBackend(patch.defaultAgent);
      const bLine = patch.defaultBackend
        ? `backend: ${patch.defaultBackend} (sticky)`
        : `backend: auto-infer → ${resolved} for agent '${patch.defaultAgent}'`;
      return {
        text: `✅ default agent set to '${patch.defaultAgent}' for this host\n${bLine}`,
      };
    }
    case "defaults": {
      if (!prefs) return { text: "preferences store unavailable" };
      const p = prefs.get();
      return {
        text: [
          "automode sticky defaults:",
          `  agent:     ${p.defaultAgent ?? "(unset — plugin config: " + (cfg?.defaultAgent ?? "auto") + ")"}`,
          `  backend:   ${p.defaultBackend ?? "(unset — auto-inferred from agent)"}`,
          `  autonomy:  ${p.autonomy ?? "(unset — plugin config: " + (cfg?.autonomy ?? "normal") + ")"}`,
          `  verbosity: ${p.verbosity ?? "(unset — plugin config: " + (cfg?.verbosity ?? 1) + ")"}`,
          p.updatedAt ? `  updated:   ${new Date(p.updatedAt).toISOString()}` : "",
        ].filter(Boolean).join("\n"),
      };
    }
    case "reset-defaults":
    case "reset": {
      if (!prefs) return { text: "preferences store unavailable" };
      prefs.reset();
      return { text: "✅ sticky defaults cleared. Plugin config takes effect again." };
    }
    case "on":
    case "off": {
      if (!prefs) return { text: "preferences store unavailable" };
      if (!cfg) return { text: "automode: config not provided" };
      const chatId = resolveTaskChatId(ctx, cfg);
      if (!chatId) {
        return {
          text: "Cannot enable default-mode for this chat: no chat id could be resolved. Run this from a Telegram DM or set telegram.chatId in the plugin config.",
        };
      }
      const next = { ...(prefs.get().chatDefaults ?? {}), [chatId]: sub === "on" };
      prefs.set({ chatDefaults: next });
      return {
        text:
          sub === "on"
            ? `✅ default-to-automode ON for chat \`${chatId}\`. Plain messages now become automode tasks (gate: ${cfg.defaultMode.gate}). Turn off with /automode off.`
            : `✅ default-to-automode OFF for chat \`${chatId}\`.`,
      };
    }
    case "init": {
      if (!cfg) return { text: "automode: config not provided" };
      return { text: buildInitWizard(cfg, ctx, prefs) };
    }
    case "autonomy":
    case "yolo":
    case "super-yolo":
    case "unsafe": {
      if (!prefs) return { text: "preferences store unavailable" };
      let target: AutonomyLevel | null;
      if (sub === "yolo") {
        target = "yolo";
      } else if (sub === "super-yolo" || sub === "unsafe") {
        target = "super-yolo";
      } else {
        target = parseAutonomyLevel(tail.split(/\s+/)[0]);
      }
      if (!target) {
        const p = prefs.get();
        return {
          text: [
            "Usage: /automode autonomy <strict|normal|high|yolo|super-yolo>",
            "       /automode yolo          (alias for autonomy=yolo)",
            "       /automode super-yolo    (alias for autonomy=super-yolo)",
            "       /automode unsafe        (alias for autonomy=super-yolo)",
            `Current sticky autonomy: ${p.autonomy ?? `(unset — plugin config: ${cfg?.autonomy ?? "normal"})`}`,
            "",
            "Levels:",
            "  strict     — escalate on low-confidence plans + 2 consecutive failures",
            "  normal     — default; escalate on low-confidence plans + 3 failures",
            "  high       — auto-approve plan-first & low-confidence; escalate on 5 failures",
            "  yolo       — auto-approve everything; tool denylist still enforced",
            "  super-yolo — 🚨 NO GUARDS. Allowlist + denylist + path-scope all disabled.",
          ].join("\n"),
        };
      }
      prefs.set({ autonomy: target });
      const warning =
        target === "super-yolo"
          ? "\n🚨 ALL TOOL GUARDS DISABLED. rm -rf, sudo, curl|sh, writes anywhere — all pass. Use only on a throwaway machine or VM."
          : ". Tool denylist is still enforced.";
      return {
        text: `✅ sticky autonomy set to '${target}'${warning}`,
      };
    }
    case "verbose":
    case "verbosity": {
      if (!prefs) return { text: "preferences store unavailable" };
      if (!tail) {
        const p = prefs.get();
        return {
          text: [
            "Usage: /automode verbose <0|1|2|3>",
            `Current sticky verbosity: ${p.verbosity ?? "(unset — plugin config: " + (cfg?.verbosity ?? 1) + ")"}`,
            "",
            "Levels:",
            "  0 = silent (only start / progress summary / done)",
            "  1 = info (+ one-line per-turn summary)",
            "  2 = detail (+ turn start/end + each tool call)",
            "  3 = debug (+ agent output + thought snippets)",
          ].join("\n"),
        };
      }
      const n = Number(tail.split(/\s+/)[0]);
      if (!Number.isFinite(n) || n < 0 || n > 3) {
        return { text: "verbosity must be 0, 1, 2, or 3" };
      }
      const level = Math.floor(n) as VerbosityLevel;
      prefs.set({ verbosity: level });
      return { text: `✅ sticky verbosity set to ${level}` };
    }
    case "tail": {
      if (!cfg) return { text: "automode: config not provided" };
      return { text: tailTask(cfg, tail) };
    }
    case "logs": {
      const id = tail.split(/\s+/)[0];
      if (!id) return { text: "Usage: /automode logs <id>" };
      return { text: "```\n" + tailLogsForTask(id, 80) + "\n```" };
    }
    case "template":
    case "templates": {
      if (!cfg) return { text: "automode: config not provided" };
      return handleTemplate(scheduler, ctx, cfg, prefs, templates, tail, subFlags);
    }
    case "template-new": {
      if (!templates) return { text: "automode: template store unavailable" };
      const name = tail.split(/\s+/)[0]?.trim();
      if (!name) return { text: "Usage: /automode template-new <name>" };
      const r = templates.create(name);
      return {
        text: r.ok
          ? `✅ created user template '${name}' at ${r.path}\nPopulate it with /automode template-set ${name} <field> <value>\nFields: ${EDITABLE_FIELDS.join(", ")}`
          : `✗ ${r.error}`,
      };
    }
    case "template-set": {
      if (!templates) return { text: "automode: template store unavailable" };
      // tail = "<name> <field> <value...>"
      const parts = tail.split(/\s+/);
      const name = parts[0]?.trim();
      const field = parts[1]?.trim();
      const value = parts.slice(2).join(" ").trim();
      if (!name || !field || !value) {
        return {
          text: [
            "Usage: /automode template-set <name> <field> <value>",
            `Fields: ${EDITABLE_FIELDS.join(", ")}`,
            "Examples:",
            '  /automode template-set mine goalTemplate "fix failing tests in {{arg}}"',
            "  /automode template-set mine autonomy high",
            "  /automode template-set mine maxCostUsd 2",
          ].join("\n"),
        };
      }
      const r = templates.update(name, field, stripOuterQuotes(value));
      return { text: r.ok ? `✅ ${name}.${field} = ${value}` : `✗ ${r.error}` };
    }
    case "template-delete":
    case "template-rm": {
      if (!templates) return { text: "automode: template store unavailable" };
      const name = tail.split(/\s+/)[0]?.trim();
      if (!name) return { text: "Usage: /automode template-delete <name>" };
      const r = templates.remove(name);
      return { text: r.ok ? `🗑  deleted user template '${name}'` : `✗ ${r.error}` };
    }
    case "template-clone": {
      if (!templates) return { text: "automode: template store unavailable" };
      const parts = tail.split(/\s+/).filter(Boolean);
      const src = parts[0];
      const dst = parts[1];
      if (!src) {
        return {
          text: [
            "Usage: /automode template-clone <builtin-name> [new-name]",
            "If <new-name> is omitted, clones as the same name (user copy shadows built-in).",
          ].join("\n"),
        };
      }
      const r = templates.cloneBuiltin(src, dst);
      return {
        text: r.ok
          ? `✅ cloned '${src}' → user template '${r.name}' at ${r.path}\nCustomise with /automode template-set ${r.name} <field> <value>`
          : `✗ ${r.error}`,
      };
    }
    case "ledger":
    case "cost": {
      const window = (tail.split(/\s+/)[0] ?? "all").toLowerCase();
      const w: LedgerWindow =
        window === "day" || window === "today" ? "day" :
        window === "week" ? "week" :
        window === "month" ? "month" : "all";
      const report = buildLedger(scheduler.list(), w);
      return { text: formatLedger(report) };
    }
    case "shadow": {
      if (!cfg) return { text: "automode: config not provided" };
      return handleShadow(scheduler, ctx, cfg, prefs, tail, subFlags);
    }
    case "budget": {
      if (!prefs) return { text: "preferences store unavailable" };
      const n = Number(tail.replace(/^\$/, ""));
      if (!Number.isFinite(n) || n < 0) {
        return {
          text: [
            "Usage: /automode budget <USD>",
            "  /automode budget 5       → cap each future task at $5",
            "  /automode budget 0       → disable cap",
            "Presets: 5 · 25 · 100",
            "Note: also available per-task with --budget=<USD>",
          ].join("\n"),
        };
      }
      // Cost cap is a plugin-config field today; we can't mutate the live cfg
      // from prefs, so we expose the value via a sticky and the scheduler
      // reads max(cfg.maxCostUsd, 0) — see scheduler.ts resolveBudget().
      (prefs as unknown as { set: (p: { budgetUsd: number }) => void }).set({ budgetUsd: n });
      return { text: `✅ sticky budget set to $${n.toFixed(4)} per task (0 = disabled).` };
    }
    case "status":
    case "ls":
    case "list": {
      const list = scheduler.list();
      if (list.length === 0) return { text: "No automode tasks." };
      return { text: `automode tasks:\n${list.map(fmtTaskRow).join("\n")}` };
    }
    case "stop": {
      const id = tail;
      if (!id) return { text: "Usage: /automode stop <id>" };
      const r = await scheduler.stopTask(id, "user", ctx.senderId);
      return { text: r.ok ? `Stopped ${id}.` : `✗ ${r.error}` };
    }
    case "pause": {
      const id = tail;
      if (!id) return { text: "Usage: /automode pause <id>" };
      const r = await scheduler.pauseTask(id, ctx.senderId);
      return { text: r.ok ? `Paused ${id}.` : `✗ ${r.error}` };
    }
    case "resume": {
      const id = tail;
      if (!id) return { text: "Usage: /automode resume <id>" };
      const r = await scheduler.resumeTask(id, ctx.senderId);
      return { text: r.ok ? `Resuming ${id}.` : `✗ ${r.error}` };
    }
    case "inspect":
    case "show": {
      const parts = tail.split(/\s+/).filter(Boolean);
      const id = parts[0];
      if (!id) return { text: "Usage: /automode inspect <id> [--json]" };
      const state = scheduler.get(id);
      if (!state) return { text: `No task ${id}.` };
      if (parts.includes("--json") || subFlags.rest.includes("--json")) {
        return { text: "```json\n" + JSON.stringify(state, null, 2) + "\n```" };
      }
      return { text: formatInspect(state) };
    }
    case "plan": {
      if (!cfg) return { text: "automode: config not provided" };
      return handleStart(scheduler, "hybrid", tail, ctx, cfg, prefs, subFlags, undefined, true);
    }
    case "interval": {
      if (!cfg) return { text: "automode: config not provided" };
      const parsed = parseInterval(tail);
      if (!parsed) return { text: "Usage: /automode interval <N{s|m|h}> <goal>" };
      return handleStart(scheduler, "interval", parsed.rest, ctx, cfg, prefs, subFlags, parsed.intervalSec);
    }
    case "goal": {
      if (!cfg) return { text: "automode: config not provided" };
      return handleStart(scheduler, "goal", tail, ctx, cfg, prefs, subFlags);
    }
    case "paced": {
      if (!cfg) return { text: "automode: config not provided" };
      return handleStart(scheduler, "paced", tail, ctx, cfg, prefs, subFlags);
    }
    case "hybrid": {
      if (!cfg) return { text: "automode: config not provided" };
      return handleStart(scheduler, "hybrid", tail, ctx, cfg, prefs, subFlags);
    }
    default: {
      // Unreachable — KNOWN gate filters these.
      if (!cfg) return { text: "automode: config not provided" };
      return handleStart(scheduler, "hybrid", raw, ctx, cfg, prefs, subFlags);
    }
  }
}

function formatInspect(s: TaskState): string {
  const costLine =
    typeof s.totalCostUsd === "number" ? `cost: $${s.totalCostUsd.toFixed(4)}` : "cost: n/a";
  const ownerLine = s.owner
    ? `owner: ${s.owner.senderId ?? "?"}@${s.owner.channel ?? "?"}`
    : "owner: (unset)";
  const lines = [
    `# automode task ${s.id}`,
    `status: ${s.status}   mode: ${s.mode}   turns: ${s.turnCount}/${s.caps.maxTurns}`,
    `cwd: ${s.cwd}`,
    `agent: ${s.config.defaultAgent} (${s.config.backend})`,
    `${ownerLine}   ${costLine}`,
    ``,
    `## Goal`,
    s.goal,
    ``,
    `## Progress`,
    s.progressSummary || "(none)",
    ``,
    `## Escalations (${s.escalations.length})`,
    ...s.escalations.slice(-3).map((e) => `- ${e.id}: ${e.severity} — ${e.reason.slice(0, 160)}`),
  ];
  if (s.outcomeSummary) lines.push("", "## Outcome", s.outcomeSummary);
  return lines.join("\n");
}

async function handleTemplate(
  scheduler: Scheduler,
  ctx: CommandCtx,
  cfg: AutomodeConfig,
  prefs: Preferences | undefined,
  templates: TemplateStore | undefined,
  tail: string,
  subFlags: ReturnType<typeof parseFlags>,
): Promise<CommandResult> {
  if (!templates) {
    return { text: "automode: template store unavailable" };
  }
  const parts = tail.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts[0] === "list" || parts[0] === "ls") {
    const list = templates.list();
    if (list.length === 0) {
      return {
        text: [
          "No templates found.",
          `Create one at ${templates.dir}/<name>.yaml, for example:`,
          "",
          "  name: fix-tests",
          "  goalTemplate: \"find and fix failing tests in {{arg}}\"",
          "  agent: codex",
          "  autonomy: high",
          "  maxCostUsd: 2",
        ].join("\n"),
      };
    }
    const rows = list.map((t) => {
      const badge = t.builtin ? "★" : "·";
      const name = t.name.padEnd(16);
      const caps: string[] = [];
      if (t.autonomy) caps.push(`auto=${t.autonomy}`);
      if (typeof t.maxTurns === "number") caps.push(`turns=${t.maxTurns}`);
      if (typeof t.maxCostUsd === "number") caps.push(`$${t.maxCostUsd}`);
      const tail = caps.length ? `  [${caps.join(" ")}]` : "";
      return `  ${badge} ${name} — ${t.description ?? ""}${tail}`;
    });
    return {
      text: [
        "automode templates  (★ built-in, · user-authored)",
        "",
        ...rows,
        "",
        "Run one with:",
        "  /automode template <name> <arg>",
        "Example:",
        "  /automode template fix-tests src/utils/",
        "",
        "Preview a template without running:",
        "  /automode template <name>",
        "",
        `User templates live in: ${templates.dir}/<name>.yaml`,
      ].join("\n"),
    };
  }
  // Preview-only: `/automode template <name>` with no arg dumps the template
  // so the user can inspect it before running. Running still requires an arg
  // for templates whose goalTemplate uses {{arg}}.
  if (parts.length === 1) {
    const tpl = templates.load(parts[0]!);
    if (!tpl) return { text: `no template '${parts[0]}'. Use /automode templates to list.` };
    const needsArg = /\{\{\s*args?\s*\}\}/.test(tpl.goalTemplate ?? "");
    const lines = [
      `${tpl.builtin ? "★" : "·"} template '${tpl.name}'`,
      tpl.description ? `description: ${tpl.description}` : "",
      tpl.goalTemplate ? `goalTemplate: ${tpl.goalTemplate}` : "",
      tpl.goal ? `goal: ${tpl.goal}` : "",
      tpl.agent ? `agent: ${tpl.agent}` : "",
      tpl.autonomy ? `autonomy: ${tpl.autonomy}` : "",
      typeof tpl.maxTurns === "number" ? `maxTurns: ${tpl.maxTurns}` : "",
      typeof tpl.maxCostUsd === "number" ? `maxCostUsd: $${tpl.maxCostUsd}` : "",
      "",
      needsArg
        ? `Run: /automode template ${tpl.name} <arg>`
        : `Run: /automode template ${tpl.name}`,
    ].filter(Boolean);
    return { text: lines.join("\n") };
  }
  const name = parts[0]!;
  const args = parts.slice(1).join(" ");
  const tpl = templates.load(name);
  if (!tpl) return { text: `no template '${name}'. Use /automode templates to list.` };
  const goal = renderGoal(tpl, args);
  if (!goal) return { text: `template '${name}' has no goal — set goalTemplate or goal.` };
  const target = resolveTarget(subFlags.agent ?? tpl.agent, subFlags.backend ?? tpl.backend, cfg, prefs);
  const state = await scheduler.startTask({
    goal,
    mode: "hybrid",
    agent: target.agent,
    backend: target.backend,
    autonomy: subFlags.autonomy ?? tpl.autonomy ?? (prefs?.get().autonomy ?? cfg.autonomy),
    verbosity: subFlags.verbosity ?? tpl.verbosity,
    maxTurns: subFlags.maxTurns ?? tpl.maxTurns,
    maxDurationSec: subFlags.maxDurationSec ?? tpl.maxDurationSec,
    maxCostUsd: subFlags.budgetUsd ?? tpl.maxCostUsd,
    scopePaths: tpl.scopePaths,
    onDone: subFlags.onDone ?? tpl.onDone,
    onFail: subFlags.onFail ?? tpl.onFail,
    dryRun: Boolean(subFlags.dryRun),
    templateName: tpl.name,
    chatId: resolveTaskChatId(ctx, cfg),
    owner: ctx.senderId || ctx.channel ? { channel: ctx.channel, senderId: ctx.senderId } : undefined,
  });
  return {
    text: `🚀 template '${tpl.name}' started\nid: \`${state.id}\`\ngoal: ${state.goal.slice(0, 200)}`,
  };
}

async function handleShadow(
  scheduler: Scheduler,
  ctx: CommandCtx,
  cfg: AutomodeConfig,
  prefs: Preferences | undefined,
  tail: string,
  subFlags: ReturnType<typeof parseFlags>,
): Promise<CommandResult> {
  // Expect shape: /automode shadow -a agent1 -a agent2 "the goal"
  // Single --agent flags are merged from subFlags; we also re-parse to pull
  // the second occurrence since parseFlags only keeps the last value.
  const tokens = tail.split(/\s+/);
  const agents: string[] = [];
  let i = 0;
  const nonFlag: string[] = [];
  while (i < tokens.length) {
    const t = tokens[i]!;
    if ((t === "-a" || t === "--agent") && i + 1 < tokens.length) {
      agents.push(tokens[++i]!);
    } else if (t.startsWith("--agent=")) {
      agents.push(t.slice("--agent=".length));
    } else if (t.startsWith("-a=")) {
      agents.push(t.slice("-a=".length));
    } else if (!t.startsWith("-")) {
      nonFlag.push(t);
    }
    i++;
  }
  const goal = nonFlag.join(" ").trim();
  if (agents.length < 2 || !goal) {
    return {
      text: [
        "Usage: /automode shadow -a <agent1> -a <agent2> [-a <agent3>] <goal>",
        "Spawns parallel identical tasks on each agent; compare with:",
        "  /automode inspect <id>  (for each id printed)",
      ].join("\n"),
    };
  }
  const ids: string[] = [];
  // Pre-allocate so every peer sees the others.
  for (let k = 0; k < agents.length; k++) ids.push("");
  const resolved = await Promise.all(
    agents.map(async (agent, idx) => {
      const state = await scheduler.startTask({
        goal,
        mode: "hybrid",
        agent,
        backend: subFlags.backend === "acpx" || subFlags.backend === "claude-acp" ? subFlags.backend : undefined,
        autonomy: subFlags.autonomy ?? prefs?.get().autonomy ?? cfg.autonomy,
        verbosity: subFlags.verbosity ?? cfg.verbosity,
        dryRun: Boolean(subFlags.dryRun),
        chatId: resolveTaskChatId(ctx, cfg),
        owner: ctx.senderId || ctx.channel ? { channel: ctx.channel, senderId: ctx.senderId } : undefined,
      });
      ids[idx] = state.id;
      return state;
    }),
  );
  // Patch shadowPeers on each task now that all ids are known.
  for (const st of resolved) {
    st.shadowPeers = ids.filter((x) => x && x !== st.id);
    (scheduler as unknown as { store: { save: (s: typeof st) => void } }).store?.save?.(st);
  }
  return {
    text: [
      `🌓 shadow run: ${agents.length} parallel agent(s)`,
      ...resolved.map((s, i) => `  ${agents[i]} → \`${s.id}\``),
      ``,
      `Inspect any: /automode inspect <id>`,
    ].join("\n"),
  };
}

export function helpText(): string {
  return [
    "automode — autonomous focus mode",
    "",
    "Start a task:",
    "  /automode <goal>                       Start (hybrid mode)",
    "  /automode plan <goal>                  Plan-first: wait for approval",
    "  /automode goal <goal>                  Goal mode (no reschedules)",
    "  /automode paced <goal>                 Paced (agent self-reschedules)",
    "  /automode interval <Xm> <goal>         Interval mode (every X minutes)",
    "",
    "Per-task flag overrides (can appear anywhere):",
    "  --agent=<id> | -a <id>                 Pick agent for this task only",
    "  --backend=<acpx|claude-acp> | -b <id>  Pick ACP backend (auto when omitted)",
    "  --autonomy=<level> | --yolo | -y       strict|normal|high|yolo|super-yolo",
    "  --super-yolo | --unsafe | -yy          🚨 no tool guards (bypass everything)",
    "  --verbose=<0-3> | -v | -vv | -vvv      Live Telegram verbosity",
    "  --plan                                 Force plan-first",
    "  --turns=<n> --mins=<n>                 Override caps",
    "  --budget=<USD>                         Cost cap for this task",
    "  --dry-run | --dry | -n                 Simulate; no tools execute",
    "  --on-done=\"<cmd>\"                      Follow-up slash command on success",
    "  --on-fail=\"<cmd>\"                      Follow-up slash command on failure",
    "",
    "Sticky defaults for this host:",
    "  /automode use <agent>                  Set default agent (e.g. kimi)",
    "  /automode use <agent> -b acpx          Also pin backend",
    "  /automode autonomy <level>             Set default autonomy",
    "  /automode yolo                         Shortcut: autonomy=yolo",
    "  /automode super-yolo | unsafe          🚨 autonomy=super-yolo (no guards)",
    "  /automode verbose <0-3>                Set default verbosity",
    "  /automode defaults                     Show current sticky defaults",
    "  /automode reset-defaults               Clear sticky defaults",
    "",
    "Inspect / stream:",
    "  /automode status                       List tasks",
    "  /automode inspect <id> [--json]        Full state dump",
    "  /automode tail <id> [N] [--json]       Last N turns (audit)",
    "  /automode logs <id>                    Gateway log lines for this task",
    "  /automode ledger [day|week|month|all]  Cost + status report",
    "",
    "Templates, chaining, shadow:",
    "  /automode templates                    List saved templates (★ built-in)",
    "  /automode template <name>              Preview template (no run)",
    "  /automode template <name> <arg>        Start from a template",
    "  /automode template-new <name>          Create empty user template",
    "  /automode template-set <n> <f> <v>     Edit a field (desc, goalTemplate, …)",
    "  /automode template-clone <builtin>     Copy a built-in for customisation",
    "  /automode template-delete <name>       Remove a user template",
    "  /automode shadow -a X -a Y <goal>      Run same goal on ≥2 agents in parallel",
    "  /automode budget <USD>                 Sticky cost cap (0 = disabled)",
    "",
    "Control:",
    "  /automode stop <id>                    Kill a task",
    "  /automode pause|resume <id>            Pause / resume",
    "  /automode doctor                       Diagnose SDK + agents",
    "  /automode help                         This help",
    "",
    "Verbosity levels:",
    "  0 silent | 1 summary | 2 +tool calls | 3 +agent output",
    "",
    "Autonomy levels:",
    "  strict | normal | high | yolo  — tool denylist enforced",
    "  super-yolo (aka unsafe)        — 🚨 NO GUARDS; use only on throwaway VM",
  ].join("\n");
}

async function doctor(
  cfg?: AutomodeConfig,
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
  prefs?: Preferences,
): Promise<string> {
  const log = logger ?? { info: () => undefined, warn: () => undefined, error: () => undefined };
  const roots = findOpenclawRoots();
  const preflight = await sdkPreflight(log);
  const lines: string[] = [
    "# automode doctor",
    "",
    `SDK preflight: ${preflight.ok ? "OK" : "FAILED"}`,
    preflight.resolvedFrom ? `  loaded from: ${preflight.resolvedFrom}` : "",
    preflight.error ? `  error: ${preflight.error.split("\n")[0]}` : "",
    "",
    `OpenClaw install roots found: ${roots.length}`,
    ...roots.map((r) => `  - ${r}`),
    "",
  ];
  if (cfg) {
    lines.push(
      `Configured backend: ${cfg.backend}`,
      `Configured defaultAgent: ${cfg.defaultAgent}`,
      `Configured fallbackAgents: [${cfg.fallbackAgents.join(", ")}]`,
      `Discovered acpx agents: [${cfg.discoveredAcpxAgents.join(", ") || "(none — configure plugins.entries.acpx.config.agents)"}]`,
      `Health probe: ${cfg.healthProbeEnabled ? "on" : "off"}   Max fallbacks: ${cfg.maxFallbacks}`,
    );
  }
  if (prefs) {
    const p = prefs.get();
    lines.push(
      "",
      "Sticky defaults (per host):",
      `  agent:     ${p.defaultAgent ?? "(unset)"}`,
      `  backend:   ${p.defaultBackend ?? "(unset — auto-inferred from agent)"}`,
      `  autonomy:  ${p.autonomy ?? "(unset)"}`,
      `  verbosity: ${p.verbosity ?? "(unset)"}`,
    );
  }
  return lines.filter((l) => l !== undefined).join("\n");
}
