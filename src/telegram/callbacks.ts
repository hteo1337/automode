import type { Scheduler } from "../engine/scheduler.js";

type AnyLogger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export type EscalationCallbackPayload = {
  kind: "escalation";
  taskId: string;
  escalationId: string;
  decision: "approve" | "deny" | "stop" | "modify";
  note?: string;
};

// Alias kept for backward compatibility with earlier call sites.
export type CallbackPayload = EscalationCallbackPayload;

/**
 * Parse a Telegram button's `callback_data` field.
 *
 * Formats:
 *   - `automode:<taskId>:<escalationId>:<decision>`  → escalation
 *   - `automode:menu:...` is NOT parsed here; the menu dispatcher handles
 *     it directly via `parseMenuData` in telegram/menu.ts.
 */
export function parseCallbackData(data: string): EscalationCallbackPayload | null {
  if (!data) return null;
  if (data.startsWith("automode:menu:")) return null;
  const parts = data.split(":");
  if (parts.length < 4 || parts[0] !== "automode") return null;
  const [, taskId, escalationId, decisionRaw] = parts;
  if (!taskId || !escalationId || !decisionRaw) return null;
  const decision = decisionRaw.toLowerCase();
  if (decision !== "approve" && decision !== "deny" && decision !== "stop" && decision !== "modify") {
    return null;
  }
  return { kind: "escalation", taskId, escalationId, decision };
}

export async function handleCallback(
  scheduler: Scheduler,
  data: string,
  logger: AnyLogger,
): Promise<{ ok: boolean; message: string }> {
  const payload = parseCallbackData(data);
  if (!payload) return { ok: false, message: `invalid callback data: ${data}` };
  logger.info(
    `[automode] callback task=${payload.taskId} esc=${payload.escalationId} decision=${payload.decision}`,
  );
  const ok = await scheduler.resolveEscalation(
    payload.taskId,
    payload.escalationId,
    payload.decision,
    payload.note,
  );
  return { ok, message: ok ? `task ${payload.taskId}: ${payload.decision}` : "task/escalation not found" };
}
