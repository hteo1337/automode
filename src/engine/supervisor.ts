import type { SupervisorDecision, TaskState, TurnRecord } from "../types.js";

export type SupervisorInput = {
  task: TaskState;
  turn: TurnRecord;
  completeCalled?: { summary: string };
  escalateCalled?: { reason: string; severity: "info" | "warn" | "block" };
  rescheduleCalled?: { delaySec: number; note?: string };
  stopRequested?: boolean;
  deniedToolCalls: Array<{ name: string; reason: string }>;
  maxCostUsd?: number;
};

export function decide(input: SupervisorInput): SupervisorDecision {
  const { task, turn } = input;

  if (input.stopRequested) return { kind: "stopped" };

  if (input.completeCalled) {
    return { kind: "done", summary: input.completeCalled.summary };
  }

  if (input.escalateCalled) {
    return {
      kind: "escalate",
      reason: input.escalateCalled.reason,
      severity: input.escalateCalled.severity,
    };
  }

  if (input.deniedToolCalls.length > 0) {
    const first = input.deniedToolCalls[0]!;
    return {
      kind: "escalate",
      reason: `tool '${first.name}' blocked: ${first.reason}`,
      severity: "block",
    };
  }

  if (turn.error) {
    if (consecutiveFailures(task, turn) >= 3) {
      return { kind: "failed", error: `3 consecutive failures, last: ${turn.error}` };
    }
  }

  const elapsedSec = task.startedAt ? (Date.now() - task.startedAt) / 1000 : 0;
  if (task.turnCount >= task.caps.maxTurns) return { kind: "capped", reason: "turns" };
  if (elapsedSec >= task.caps.maxDurationSec) return { kind: "capped", reason: "duration" };
  if (input.maxCostUsd && input.maxCostUsd > 0 && (task.totalCostUsd ?? 0) >= input.maxCostUsd) {
    return { kind: "capped", reason: "cost" };
  }

  if (input.rescheduleCalled) {
    return {
      kind: "reschedule",
      delaySec: Math.max(1, Math.floor(input.rescheduleCalled.delaySec)),
      note: input.rescheduleCalled.note,
    };
  }

  return { kind: "continue" };
}

function consecutiveFailures(_task: TaskState, turn: TurnRecord): number {
  // Simple heuristic on the current turn; full history comparison is in
  // scheduler which tracks failure streaks across reloads.
  return turn.error ? 1 : 0;
}
