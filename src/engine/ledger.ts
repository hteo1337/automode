import type { TaskState } from "../types.js";

export type LedgerWindow = "day" | "week" | "month" | "all";

export type LedgerEntry = {
  id: string;
  createdAt: number;
  endedAt?: number;
  status: TaskState["status"];
  agent: string;
  backend: string;
  turnCount: number;
  totalCostUsd: number;
};

export type LedgerReport = {
  window: LedgerWindow;
  since: number;
  until: number;
  count: number;
  totalCostUsd: number;
  turnCount: number;
  byStatus: Record<string, number>;
  byAgent: Record<string, { count: number; costUsd: number }>;
  topCost: LedgerEntry[];
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export function windowMs(w: LedgerWindow, nowMs: number = Date.now()): { since: number; until: number } {
  switch (w) {
    case "day":
      return { since: nowMs - DAY, until: nowMs };
    case "week":
      return { since: nowMs - 7 * DAY, until: nowMs };
    case "month":
      return { since: nowMs - 30 * DAY, until: nowMs };
    case "all":
    default:
      return { since: 0, until: nowMs };
  }
}

export function buildLedger(tasks: TaskState[], window: LedgerWindow = "all"): LedgerReport {
  const { since, until } = windowMs(window);
  const entries: LedgerEntry[] = tasks
    .filter((t) => t.createdAt >= since && t.createdAt <= until)
    .map((t) => ({
      id: t.id,
      createdAt: t.createdAt,
      endedAt: t.endedAt,
      status: t.status,
      agent: t.config.defaultAgent,
      backend: t.config.backend,
      turnCount: t.turnCount,
      totalCostUsd: t.totalCostUsd ?? 0,
    }));

  const byStatus: Record<string, number> = {};
  const byAgent: Record<string, { count: number; costUsd: number }> = {};
  let totalCostUsd = 0;
  let turnCount = 0;
  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    const a = (byAgent[e.agent] = byAgent[e.agent] ?? { count: 0, costUsd: 0 });
    a.count += 1;
    a.costUsd += e.totalCostUsd;
    totalCostUsd += e.totalCostUsd;
    turnCount += e.turnCount;
  }
  const topCost = [...entries]
    .sort((x, y) => y.totalCostUsd - x.totalCostUsd)
    .slice(0, 10);

  return {
    window,
    since,
    until,
    count: entries.length,
    totalCostUsd,
    turnCount,
    byStatus,
    byAgent,
    topCost,
  };
}

export function formatLedger(r: LedgerReport): string {
  const windowLabel = r.window === "all" ? "all time" : `last ${r.window}`;
  const lines: string[] = [
    `# automode ledger — ${windowLabel}`,
    `tasks: ${r.count}   turns: ${r.turnCount}   cost: $${r.totalCostUsd.toFixed(4)}`,
    ``,
    `## By status`,
    ...Object.entries(r.byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `  ${s.padEnd(10)} ${n}`),
    ``,
    `## By agent`,
    ...Object.entries(r.byAgent)
      .sort((a, b) => b[1].costUsd - a[1].costUsd)
      .map(
        ([name, s]) =>
          `  ${name.padEnd(28)} ${String(s.count).padStart(4)} tasks   $${s.costUsd.toFixed(4)}`,
      ),
  ];
  if (r.topCost.length > 0) {
    lines.push("", "## Top cost");
    for (const e of r.topCost.slice(0, 5)) {
      lines.push(
        `  ${e.id}   ${e.status.padEnd(10)}   ${e.agent.padEnd(24)}   $${e.totalCostUsd.toFixed(4)}`,
      );
    }
  }
  return lines.join("\n");
}
