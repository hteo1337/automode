import type { TaskState } from "../types.js";

/** Single-file HTML dashboard. No JS framework, no external assets. */
export function renderDashboard(tasks: TaskState[]): string {
  const rows = tasks
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 200)
    .map((t) => {
      const age = ((Date.now() - t.createdAt) / 1000).toFixed(0);
      const cost =
        typeof t.totalCostUsd === "number" ? `$${t.totalCostUsd.toFixed(4)}` : "–";
      const owner = t.owner?.senderId ?? "–";
      return `
      <tr class="status-${escapeAttr(t.status)}">
        <td class="mono">${escape(t.id)}</td>
        <td>${escape(t.status)}</td>
        <td>${escape(t.config.autonomy)}</td>
        <td>${escape(t.config.defaultAgent)}@${escape(t.config.backend)}</td>
        <td>${t.turnCount}/${t.caps.maxTurns}</td>
        <td>${cost}</td>
        <td>${escape(owner)}</td>
        <td>${age}s</td>
        <td class="goal">${escape(truncate(t.goal, 160))}</td>
      </tr>`;
    })
    .join("");

  const totals = {
    running: tasks.filter((t) =>
      ["running", "planning", "escalating", "waiting"].includes(t.status),
    ).length,
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => ["failed", "capped"].includes(t.status)).length,
    cost: tasks.reduce((s, t) => s + (t.totalCostUsd ?? 0), 0),
  };

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>automode dashboard</title>
<style>
  :root { color-scheme: light dark; --bg: Canvas; --fg: CanvasText; --muted: GrayText; }
  body { font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 24px; background: var(--bg); color: var(--fg); }
  h1 { margin: 0 0 8px; font-size: 18px; }
  .subtitle { color: var(--muted); margin-bottom: 16px; font-size: 13px; }
  .stats { display: flex; gap: 18px; margin: 0 0 18px; flex-wrap: wrap; }
  .stat { padding: 10px 14px; border: 1px solid CanvasText; border-radius: 6px; opacity: 0.85; }
  .stat b { font-size: 18px; display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); }
  td.mono { font-family: inherit; }
  td.goal { max-width: 520px; }
  tr.status-done { opacity: 0.65; }
  tr.status-failed, tr.status-capped { color: #c33; }
  tr.status-escalating { color: #d80; }
  tr.status-running { font-weight: 600; }
  footer { margin-top: 24px; color: var(--muted); font-size: 12px; }
</style>
</head><body>
<h1>automode</h1>
<div class="subtitle">auto-refresh every 5s · ${new Date().toISOString()}</div>
<div class="stats">
  <div class="stat"><b>${totals.running}</b>running</div>
  <div class="stat"><b>${totals.done}</b>done</div>
  <div class="stat"><b>${totals.failed}</b>failed/capped</div>
  <div class="stat"><b>$${totals.cost.toFixed(4)}</b>total cost</div>
</div>
<table>
  <thead><tr>
    <th>id</th><th>status</th><th>autonomy</th><th>agent@backend</th>
    <th>turns</th><th>cost</th><th>owner</th><th>age</th><th>goal</th>
  </tr></thead>
  <tbody>${rows || '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--muted)">no tasks yet</td></tr>'}</tbody>
</table>
<footer>@oc-moth/automode · data from ~/.openclaw/automode/tasks/*/state.json</footer>
</body></html>`;
}

function escape(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escape(s).replace(/ /g, "-");
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max) + "…";
}
