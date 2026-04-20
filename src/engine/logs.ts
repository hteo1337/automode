import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tail the gateway log and filter lines relevant to a specific task id.
 * This is best-effort: we rely on the plugin's own log prefix `[automode]`
 * plus any line mentioning the task id.
 */
export function tailLogsForTask(taskId: string, maxLines = 80): string {
  const candidates = [
    path.join(os.homedir(), ".openclaw", "logs", "gateway.log"),
    path.join(os.homedir(), ".openclaw", "logs", "gateway.err.log"),
  ].filter(fs.existsSync);
  if (candidates.length === 0) return "(no gateway log files found)";

  const matcher = new RegExp(`\\b${escapeRegex(taskId)}\\b|\\[automode\\]`);
  const windowBytes = 2 * 1024 * 1024; // last 2 MB
  const out: string[] = [];
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file);
      const from = Math.max(0, stat.size - windowBytes);
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(stat.size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        const text = buf.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          if (matcher.test(line)) out.push(line);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // skip on error
    }
  }
  if (out.length === 0) return `(no log lines matched ${taskId} or [automode])`;
  return out.slice(-maxLines).join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
