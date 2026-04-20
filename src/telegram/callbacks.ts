import type { Scheduler } from "../engine/scheduler.js";

type AnyLogger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export type CallbackPayload = {
  taskId: string;
  escalationId: string;
  decision: "approve" | "deny" | "stop" | "modify";
  note?: string;
};

export function parseCallbackData(data: string): CallbackPayload | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts.length < 4 || parts[0] !== "automode") return null;
  const [, taskId, escalationId, decisionRaw] = parts;
  if (!taskId || !escalationId || !decisionRaw) return null;
  const decision = decisionRaw.toLowerCase();
  if (decision !== "approve" && decision !== "deny" && decision !== "stop" && decision !== "modify") {
    return null;
  }
  return { taskId, escalationId, decision };
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
