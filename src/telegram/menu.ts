import type { Scheduler } from "../engine/scheduler.js";
import type { Preferences } from "../engine/preferences.js";
import type { TemplateStore } from "../engine/templates.js";
import type { AutomodeConfig } from "../types.js";
import type { TelegramButton } from "./notifier.js";

/**
 * Callback-data namespacing for the menu. Separate from the escalation
 * callbacks (`automode:<taskId>:<escalationId>:<decision>`) because menus
 * don't address a specific task/escalation. All menu callbacks start with
 * `automode:menu:`.
 *
 * Forms:
 *   automode:menu:<action>                 — leaf action, e.g. status
 *   automode:menu:<action>:<arg>           — parameterised, e.g. autonomy:yolo
 *   automode:menu:nav:<page>               — open a submenu page
 *   automode:menu:nav:<page>:<arg>         — open a submenu with state, e.g. nav:task:<taskId>
 *   automode:menu:<action>:<a>:<b>         — multi-arg action; args[] preserves all parts
 */
export const MENU_PREFIX = "automode:menu:";

export type MenuPayload =
  | { kind: "action"; action: string; arg?: string; args: string[] }
  | { kind: "nav"; page: string; arg?: string };

export function parseMenuData(raw: string): MenuPayload | null {
  if (!raw.startsWith(MENU_PREFIX)) return null;
  const rest = raw.slice(MENU_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length === 0 || !parts[0]) return null;
  if (parts[0] === "nav") {
    if (!parts[1]) return null; // nav requires a page
    const arg = parts.slice(2).join(":"); // allow ids containing ':'
    return { kind: "nav", page: parts[1], arg: arg || undefined };
  }
  const args = parts.slice(1);
  const arg = args[0];
  return { kind: "action", action: parts[0], arg, args };
}

export type MenuPage = "root" | "autonomy" | "budget" | "verbose" | "tasks" | "task" | "templates";

export type MenuContent = {
  text: string;
  buttons: TelegramButton[][];
};

export function buildMenu(
  page: MenuPage,
  scheduler: Scheduler,
  cfg: AutomodeConfig,
  prefs?: Preferences,
  pageArg?: string,
  templates?: TemplateStore,
): MenuContent {
  switch (page) {
    case "root":
      return rootMenu(scheduler, cfg, prefs);
    case "autonomy":
      return autonomyMenu(prefs, cfg);
    case "budget":
      return budgetMenu(prefs, cfg);
    case "verbose":
      return verboseMenu(prefs, cfg);
    case "tasks":
      return tasksMenu(scheduler, pageArg);
    case "task":
      return taskDetailMenu(scheduler, pageArg ?? "");
    case "templates":
      return templatesMenu(templates);
    default:
      return rootMenu(scheduler, cfg, prefs);
  }
}

function templatesMenu(templates: TemplateStore | undefined): MenuContent {
  const list = templates?.list() ?? [];
  const builtins = list.filter((t) => t.builtin);
  const user = list.filter((t) => !t.builtin);
  const rows: string[] = ["🧩  *Templates*"];
  if (user.length > 0) {
    rows.push("", "*Your templates*");
    for (const t of user) rows.push(`· \`${t.name}\` — ${t.description ?? ""}`);
  }
  if (builtins.length > 0) {
    rows.push("", "*Built-in (read-only)*");
    for (const t of builtins) rows.push(`★ \`${t.name}\` — ${t.description ?? ""}`);
  }
  rows.push(
    "",
    "Tap *View* for the full list in one message, or use the mutation commands below.",
    "",
    "🔧 *Create / edit / remove*",
    "· `/automode template-new <name>`",
    "· `/automode template-set <name> <field> <value>`",
    "· `/automode template-clone <builtin> [new-name]`",
    "· `/automode template-delete <name>`",
    "",
    "Run a template:",
    "· `/automode template <name> <arg>`",
  );
  const buttons: TelegramButton[][] = [
    [
      { text: "📋  View full list", callback_data: `${MENU_PREFIX}templates`, style: "primary" },
    ],
    [
      { text: "➕  New", callback_data: `${MENU_PREFIX}tplhint:new` },
      { text: "✏️  Edit", callback_data: `${MENU_PREFIX}tplhint:edit` },
    ],
    [
      { text: "📋  Clone", callback_data: `${MENU_PREFIX}tplhint:clone` },
      { text: "🗑  Delete", callback_data: `${MENU_PREFIX}tplhint:delete`, style: "danger" },
    ],
    [{ text: "‹  Back", callback_data: `${MENU_PREFIX}nav:root` }],
  ];
  return { text: rows.join("\n"), buttons };
}

const LIVE_STATUSES = ["pending", "planning", "running", "waiting", "escalating", "paused"] as const;

function isLiveStatus(s: string): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(s);
}

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) + "…" : id;
}

function statusGlyph(status: string): string {
  switch (status) {
    case "running":
      return "🟢";
    case "planning":
    case "pending":
      return "🔵";
    case "waiting":
      return "🟡";
    case "paused":
      return "⏸️";
    case "escalating":
      return "⚠️";
    case "done":
      return "✅";
    case "capped":
      return "🟠";
    case "failed":
      return "❌";
    case "stopped":
      return "⛔";
    default:
      return "⚪";
  }
}

function formatCost(c: number | undefined): string {
  return typeof c === "number" ? `$${c.toFixed(3)}` : "";
}

const TASKS_PAGE_SIZE = 8;

type TaskFilter = "running" | "all" | "done" | "failed";

const FAILED_STATUSES = new Set(["capped", "failed", "stopped"]);

function parseTasksArg(arg: string | undefined): { filter: TaskFilter; page: number } {
  if (!arg) return { filter: "running", page: 1 };
  const [f = "", p = ""] = arg.split(":");
  const filter: TaskFilter = (["running", "all", "done", "failed"] as const).includes(
    f as TaskFilter,
  )
    ? (f as TaskFilter)
    : "running";
  const parsed = parseInt(p, 10);
  const page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  return { filter, page };
}

function applyFilter(all: ReturnType<Scheduler["list"]>, filter: TaskFilter) {
  switch (filter) {
    case "running":
      return all.filter((t) => isLiveStatus(t.status));
    case "done":
      return all.filter((t) => t.status === "done");
    case "failed":
      return all.filter((t) => FAILED_STATUSES.has(t.status));
    case "all":
    default:
      return [...all];
  }
}

function tasksMenu(scheduler: Scheduler, arg: string | undefined): MenuContent {
  const { filter, page } = parseTasksArg(arg);
  const all = scheduler.list();

  const runningCount = all.filter((t) => isLiveStatus(t.status)).length;
  const doneCount = all.filter((t) => t.status === "done").length;
  const failedCount = all.filter((t) => FAILED_STATUSES.has(t.status)).length;
  const totalCount = all.length;

  const filtered = applyFilter(all, filter).sort(
    (a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0),
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / TASKS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * TASKS_PAGE_SIZE;
  const pageTasks = filtered.slice(start, start + TASKS_PAGE_SIZE);

  const header = [
    "📋  *Tasks*",
    `🟢 ${runningCount} running · ✅ ${doneCount} done · ❌ ${failedCount} failed · total ${totalCount}`,
    filtered.length === 0
      ? `_No ${filter} tasks._`
      : `_Showing ${start + 1}–${start + pageTasks.length} of ${filtered.length} (${filter})_`,
  ].join("\n");

  const buttons: TelegramButton[][] = [];

  // Tab row — laid out as 2-per-row so full English labels fit without
  // Telegram truncating to "…". Active tab gets a "• " prefix.
  const collected: TelegramButton[] = [];
  const tab = (
    f: TaskFilter,
    label: string,
    count: number,
    always = false,
  ): void => {
    if (!always && count === 0) return;
    const active = filter === f;
    collected.push({
      text: `${active ? "• " : ""}${label} ${count}`,
      callback_data: `${MENU_PREFIX}nav:tasks:${f}:1`,
    });
  };
  tab("running", "🟢 Running", runningCount, true);
  tab("all", "🗂 All", totalCount);
  tab("done", "✅ Done", doneCount);
  tab("failed", "❌ Failed", failedCount);
  for (let i = 0; i < collected.length; i += 2) {
    buttons.push(collected.slice(i, i + 2));
  }

  for (const t of pageTasks) {
    buttons.push([
      {
        text: taskRowLabel(t),
        callback_data: `${MENU_PREFIX}inspect:${t.id}`,
      },
    ]);
  }

  if (totalPages > 1) {
    const prevPage = safePage > 1 ? safePage - 1 : safePage;
    const nextPage = safePage < totalPages ? safePage + 1 : safePage;
    buttons.push([
      {
        text: safePage > 1 ? "‹  Prev" : " · ",
        callback_data: `${MENU_PREFIX}nav:tasks:${filter}:${prevPage}`,
      },
      {
        text: `${safePage} / ${totalPages}`,
        callback_data: `${MENU_PREFIX}noop`,
      },
      {
        text: safePage < totalPages ? "Next  ›" : " · ",
        callback_data: `${MENU_PREFIX}nav:tasks:${filter}:${nextPage}`,
      },
    ]);
  }

  buttons.push([
    { text: "🔄  Refresh", callback_data: `${MENU_PREFIX}nav:tasks:${filter}:${safePage}` },
    { text: "‹  Back", callback_data: `${MENU_PREFIX}nav:root` },
  ]);

  return { text: header, buttons };
}

function taskRowLabel(t: {
  id: string;
  status: string;
  turnCount: number;
  caps: { maxTurns: number };
  totalCostUsd?: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt?: number;
  title?: string;
  goal?: string;
}): string {
  // Glyph color-codes the status; then task id + short title + metric.
  // Title falls back to a truncated goal when absent (older tasks, pre-0.5.2).
  const titleRaw = (t.title ?? t.goal ?? "").trim();
  const titleClipped = titleRaw.length > 28 ? titleRaw.slice(0, 25) + "…" : titleRaw;
  const titlePart = titleClipped ? ` — ${titleClipped}` : "";
  const cost = formatCost(t.totalCostUsd) || "—";
  if (isLiveStatus(t.status)) {
    return `${statusGlyph(t.status)}  ${shortId(t.id)}${titlePart}  ·  t${t.turnCount}/${t.caps.maxTurns}  ·  ${cost}`;
  }
  return `${statusGlyph(t.status)}  ${shortId(t.id)}${titlePart}  ·  ${cost}`;
}

function taskDetailMenu(scheduler: Scheduler, taskId: string): MenuContent {
  const t = scheduler.get(taskId);
  if (!t) {
    return {
      text: `⚠️  Task \`${taskId}\` not found.`,
      buttons: [[{ text: "‹  Back to tasks", callback_data: `${MENU_PREFIX}nav:tasks` }]],
    };
  }
  const live = isLiveStatus(t.status);
  const elapsed = t.startedAt ? Date.now() - t.startedAt : 0;
  const tailing = !!t.telegram?.tailActive;
  const goalClipped = t.goal.length > 400 ? t.goal.slice(0, 397) + "…" : t.goal;
  const titleLine = t.title ? `*${escapeMd(t.title)}*  ` : "";
  const text = [
    `🔍  *Task* \`${t.id}\``,
    `${titleLine}${statusGlyph(t.status)} \`${t.status}\` · turn ${t.turnCount}/${t.caps.maxTurns} · ${formatCost(t.totalCostUsd) || "$0.000"} · ${formatElapsed(elapsed)}`,
    `agent: \`${t.config.defaultAgent}\` · autonomy: \`${t.config.autonomy}\` · mode: \`${t.mode}\``,
    "",
    `*Goal*`,
    goalClipped,
  ].join("\n");

  const buttons: TelegramButton[][] = [];
  if (live) {
    const tailRow: TelegramButton[] = [];
    if (tailing) {
      tailRow.push({
        text: "🛑  Stop tailing",
        callback_data: `${MENU_PREFIX}untail:${t.id}`,
        style: "danger",
      });
    } else {
      tailRow.push({
        text: "📡  Tail",
        callback_data: `${MENU_PREFIX}tail:${t.id}`,
        style: "primary",
      });
    }
    tailRow.push({ text: "🔄  Refresh", callback_data: `${MENU_PREFIX}nav:task:${t.id}` });
    buttons.push(tailRow);

    const controlRow: TelegramButton[] = [];
    if (t.status === "paused") {
      controlRow.push({
        text: "▶️  Resume",
        callback_data: `${MENU_PREFIX}taskresume:${t.id}`,
        style: "success",
      });
    } else {
      controlRow.push({
        text: "⏸  Pause",
        callback_data: `${MENU_PREFIX}taskpause:${t.id}`,
      });
    }
    controlRow.push({
      text: "⏹  Stop",
      callback_data: `${MENU_PREFIX}taskstop:${t.id}`,
      style: "danger",
    });
    buttons.push(controlRow);
  }
  buttons.push([{ text: "‹  Back to tasks", callback_data: `${MENU_PREFIX}nav:tasks` }]);
  return { text, buttons };
}

function escapeMd(s: string): string {
  // Telegram legacy Markdown needs `*_\`[]()` escaped. This is a
  // conservative pass so a title like "API Design *v2*" doesn't
  // break the message parse.
  return s.replace(/([*_`\[\]()])/g, "\\$1");
}

function formatElapsed(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function rootMenu(
  scheduler: Scheduler,
  cfg: AutomodeConfig,
  prefs?: Preferences,
): MenuContent {
  const running = scheduler
    .list()
    .filter((t) =>
      ["pending", "planning", "running", "waiting", "escalating", "paused"].includes(t.status),
    );
  const p = prefs?.get() ?? {};
  const agent = p.defaultAgent ?? cfg.defaultAgent;
  const autonomy = p.autonomy ?? cfg.autonomy;
  const budget = typeof p.budgetUsd === "number" ? p.budgetUsd : cfg.maxCostUsd;
  const verbosity = p.verbosity ?? cfg.verbosity;

  const text = [
    "✨  *automode control center*",
    `🧠 \`${agent}\`   🎚 \`${autonomy}\`   💎 ${budget > 0 ? `$${budget.toFixed(2)}` : "∞"}   📡 v${verbosity}`,
    running.length > 0
      ? `🟢  ${running.length} running task${running.length === 1 ? "" : "s"} — tap *Tasks* to manage`
      : "⚪  no tasks running",
    "",
    "_Tap a button, or type `/automode <goal>` to start a task._",
  ].join("\n");

  const buttons: TelegramButton[][] = [
    [
      { text: "🚀  Launch", callback_data: `${MENU_PREFIX}newtask`, style: "primary" },
      { text: "📋  Tasks", callback_data: `${MENU_PREFIX}nav:tasks` },
    ],
    [
      { text: "🎚  Autonomy", callback_data: `${MENU_PREFIX}nav:autonomy` },
      { text: "💎  Budget", callback_data: `${MENU_PREFIX}nav:budget` },
      { text: "📡  Verbose", callback_data: `${MENU_PREFIX}nav:verbose` },
    ],
    [
      { text: "🧩  Templates", callback_data: `${MENU_PREFIX}nav:templates` },
      { text: "📖  Ledger", callback_data: `${MENU_PREFIX}ledger` },
    ],
    [
      { text: "🧭  Doctor", callback_data: `${MENU_PREFIX}doctor` },
      { text: "🛠  Defaults", callback_data: `${MENU_PREFIX}defaults` },
      { text: "💡  Help", callback_data: `${MENU_PREFIX}help` },
    ],
  ];
  return { text, buttons };
}

function autonomyMenu(prefs: Preferences | undefined, cfg: AutomodeConfig): MenuContent {
  const current = prefs?.get().autonomy ?? cfg.autonomy;
  const text = [
    "🎚  *Set autonomy*",
    `current: \`${current}\``,
    "",
    "🛡  strict — escalate on low-confidence + 2 failures",
    "⚖️  normal — default; escalate on 3 failures",
    "⚡  high — auto-approve plans; escalate on 5 failures",
    "🔥  yolo — auto-approve; tool denylist still enforced",
    "☢️  super-yolo — ⚠️ NO GUARDS",
  ].join("\n");
  const buttons: TelegramButton[][] = [
    [
      { text: "🛡  strict", callback_data: `${MENU_PREFIX}autonomy:strict` },
      { text: "⚖️  normal", callback_data: `${MENU_PREFIX}autonomy:normal` },
      { text: "⚡  high", callback_data: `${MENU_PREFIX}autonomy:high` },
    ],
    [
      { text: "🔥  yolo", callback_data: `${MENU_PREFIX}autonomy:yolo`, style: "success" },
      { text: "☢️  super-yolo", callback_data: `${MENU_PREFIX}autonomy:super-yolo`, style: "danger" },
    ],
    [{ text: "‹  Back", callback_data: `${MENU_PREFIX}nav:root` }],
  ];
  return { text, buttons };
}

function budgetMenu(prefs: Preferences | undefined, cfg: AutomodeConfig): MenuContent {
  const current = prefs?.get().budgetUsd ?? cfg.maxCostUsd;
  const text = [
    "💎  *Set cost cap per task*",
    `current: ${current > 0 ? `$${current.toFixed(2)}` : "disabled"}`,
  ].join("\n");
  const buttons: TelegramButton[][] = [
    [
      { text: "💵  $1", callback_data: `${MENU_PREFIX}budget:1` },
      { text: "💵  $5", callback_data: `${MENU_PREFIX}budget:5` },
      { text: "💵  $25", callback_data: `${MENU_PREFIX}budget:25` },
      { text: "💵  $100", callback_data: `${MENU_PREFIX}budget:100` },
    ],
    [{ text: "⛔  unlimited", callback_data: `${MENU_PREFIX}budget:0`, style: "danger" }],
    [{ text: "‹  Back", callback_data: `${MENU_PREFIX}nav:root` }],
  ];
  return { text, buttons };
}

function verboseMenu(prefs: Preferences | undefined, cfg: AutomodeConfig): MenuContent {
  const current = prefs?.get().verbosity ?? cfg.verbosity;
  const text = [
    "📡  *Set default verbosity*",
    `current: ${current}`,
    "",
    "🔇  0 — silent (start / progress edit / done)",
    "🔈  1 — summary (+ one-line per-turn)",
    "🔉  2 — detail (+ tool calls)",
    "🔊  3 — debug (+ agent output snippets)",
  ].join("\n");
  const buttons: TelegramButton[][] = [
    [
      { text: "🔇  0", callback_data: `${MENU_PREFIX}verbose:0` },
      { text: "🔈  1", callback_data: `${MENU_PREFIX}verbose:1` },
      { text: "🔉  2", callback_data: `${MENU_PREFIX}verbose:2` },
      { text: "🔊  3", callback_data: `${MENU_PREFIX}verbose:3` },
    ],
    [{ text: "‹  Back", callback_data: `${MENU_PREFIX}nav:root` }],
  ];
  return { text, buttons };
}
