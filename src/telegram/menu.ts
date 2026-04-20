import type { Scheduler } from "../engine/scheduler.js";
import type { Preferences } from "../engine/preferences.js";
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
 */
export const MENU_PREFIX = "automode:menu:";

export type MenuPayload =
  | { kind: "action"; action: string; arg?: string }
  | { kind: "nav"; page: string };

export function parseMenuData(raw: string): MenuPayload | null {
  if (!raw.startsWith(MENU_PREFIX)) return null;
  const rest = raw.slice(MENU_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length === 0 || !parts[0]) return null;
  if (parts[0] === "nav") {
    if (!parts[1]) return null; // nav requires a page
    return { kind: "nav", page: parts[1] };
  }
  const arg = parts[1] ? parts[1] : undefined;
  return { kind: "action", action: parts[0], arg };
}

export type MenuPage = "root" | "autonomy" | "budget" | "verbose";

export type MenuContent = {
  text: string;
  buttons: TelegramButton[][];
};

export function buildMenu(
  page: MenuPage,
  scheduler: Scheduler,
  cfg: AutomodeConfig,
  prefs?: Preferences,
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
    default:
      return rootMenu(scheduler, cfg, prefs);
  }
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
    "🤖 *automode menu*",
    `agent: \`${agent}\`  ·  autonomy: \`${autonomy}\`  ·  budget: ${budget > 0 ? `$${budget.toFixed(2)}` : "none"}  ·  verbosity: ${verbosity}`,
    running.length > 0
      ? `${running.length} running task${running.length === 1 ? "" : "s"} — tap *Tasks* to manage`
      : "no tasks running",
    "",
    "_Tap a button, or type `/automode <goal>` to start a task._",
  ].join("\n");

  const buttons: TelegramButton[][] = [
    [
      { text: "🚀 New task", callback_data: `${MENU_PREFIX}newtask` },
      { text: "📊 Tasks", callback_data: `${MENU_PREFIX}status` },
    ],
    [
      { text: "🎯 Autonomy", callback_data: `${MENU_PREFIX}nav:autonomy` },
      { text: "💰 Budget", callback_data: `${MENU_PREFIX}nav:budget` },
      { text: "🔊 Verbose", callback_data: `${MENU_PREFIX}nav:verbose` },
    ],
    [
      { text: "📂 Templates", callback_data: `${MENU_PREFIX}templates` },
      { text: "📒 Ledger", callback_data: `${MENU_PREFIX}ledger` },
    ],
    [
      { text: "🩺 Doctor", callback_data: `${MENU_PREFIX}doctor` },
      { text: "⚙️ Defaults", callback_data: `${MENU_PREFIX}defaults` },
      { text: "❓ Help", callback_data: `${MENU_PREFIX}help` },
    ],
  ];
  return { text, buttons };
}

function autonomyMenu(prefs: Preferences | undefined, cfg: AutomodeConfig): MenuContent {
  const current = prefs?.get().autonomy ?? cfg.autonomy;
  const text = [
    "🎯 *Set autonomy*",
    `current: \`${current}\``,
    "",
    "strict — escalate on low-confidence + 2 failures",
    "normal — default; escalate on 3 failures",
    "high — auto-approve plans; escalate on 5 failures",
    "yolo — auto-approve; tool denylist still enforced",
    "super-yolo — 🚨 NO GUARDS",
  ].join("\n");
  const buttons: TelegramButton[][] = [
    [
      { text: "strict", callback_data: `${MENU_PREFIX}autonomy:strict` },
      { text: "normal", callback_data: `${MENU_PREFIX}autonomy:normal` },
      { text: "high", callback_data: `${MENU_PREFIX}autonomy:high` },
    ],
    [
      { text: "yolo", callback_data: `${MENU_PREFIX}autonomy:yolo`, style: "success" },
      { text: "🚨 super-yolo", callback_data: `${MENU_PREFIX}autonomy:super-yolo`, style: "danger" },
    ],
    [{ text: "⬅️ back", callback_data: `${MENU_PREFIX}nav:root` }],
  ];
  return { text, buttons };
}

function budgetMenu(prefs: Preferences | undefined, cfg: AutomodeConfig): MenuContent {
  const current = prefs?.get().budgetUsd ?? cfg.maxCostUsd;
  const text = [
    "💰 *Set cost cap per task*",
    `current: ${current > 0 ? `$${current.toFixed(2)}` : "disabled"}`,
  ].join("\n");
  const buttons: TelegramButton[][] = [
    [
      { text: "$1", callback_data: `${MENU_PREFIX}budget:1` },
      { text: "$5", callback_data: `${MENU_PREFIX}budget:5` },
      { text: "$25", callback_data: `${MENU_PREFIX}budget:25` },
      { text: "$100", callback_data: `${MENU_PREFIX}budget:100` },
    ],
    [{ text: "off", callback_data: `${MENU_PREFIX}budget:0`, style: "danger" }],
    [{ text: "⬅️ back", callback_data: `${MENU_PREFIX}nav:root` }],
  ];
  return { text, buttons };
}

function verboseMenu(prefs: Preferences | undefined, cfg: AutomodeConfig): MenuContent {
  const current = prefs?.get().verbosity ?? cfg.verbosity;
  const text = [
    "🔊 *Set default verbosity*",
    `current: ${current}`,
    "",
    "0 — silent (start / progress edit / done)",
    "1 — summary (+ one-line per-turn)",
    "2 — detail (+ tool calls)",
    "3 — debug (+ agent output snippets)",
  ].join("\n");
  const buttons: TelegramButton[][] = [
    [
      { text: "0", callback_data: `${MENU_PREFIX}verbose:0` },
      { text: "1", callback_data: `${MENU_PREFIX}verbose:1` },
      { text: "2", callback_data: `${MENU_PREFIX}verbose:2` },
      { text: "3", callback_data: `${MENU_PREFIX}verbose:3` },
    ],
    [{ text: "⬅️ back", callback_data: `${MENU_PREFIX}nav:root` }],
  ];
  return { text, buttons };
}
