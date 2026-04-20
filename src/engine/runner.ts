import { Dispatcher, type AcpBackend, type AcpHandle } from "../agents/dispatcher.js";
import { decide as allowDecide, parseToolCallText } from "../safety/allowlist.js";
import { scrub, scrubDeep, truncate } from "../safety/scrub.js";
import { detectComplete } from "../tools/complete.js";
import { detectEscalate } from "../tools/escalate.js";
import { detectReschedule } from "../tools/reschedule.js";
import type {
  AcpRuntimeEventLike,
  AutomodeConfig,
  TaskState,
  TurnRecord,
  VerbosityLevel,
} from "../types.js";

export type VerboseSink = {
  notifyVerbose(task: TaskState, atLeast: VerbosityLevel, line: string): Promise<void>;
};

// Per-turn safety caps — long autonomous runs can generate megabytes of
// events and fill the gateway's memory. After the cap, we keep counters
// but stop pushing to the in-memory buffers.
const MAX_EVENTS_PER_TURN = 2000;
const MAX_OUTPUT_CHARS_PER_TURN = 64 * 1024;   // 64 KB
const MAX_THOUGHT_CHARS_PER_TURN = 32 * 1024;  // 32 KB
// Hard cap per turn; after this, we abort the turn. Claude-acp has its own
// turn limits; this is a belt-and-braces guard.
const TURN_WATCHDOG_MS = 10 * 60 * 1000;        // 10 minutes

type AnyLogger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export type TurnOutcome = {
  record: TurnRecord;
  outputText: string;
  thoughtText: string;
  completeCalled?: { summary: string };
  escalateCalled?: { reason: string; severity: "info" | "warn" | "block" };
  rescheduleCalled?: { delaySec: number; note?: string };
  deniedToolCalls: Array<{ name: string; reason: string }>;
};

const CONTROL_SENTINELS = `You control the automode loop via these three sentinel tags emitted in your output (exact case, one per line at the end):

  <automode:complete>one-line summary of what was accomplished</automode:complete>
  <automode:escalate severity="warn">why you need a human decision</automode:escalate>
  <automode:reschedule seconds="300">waiting on build/deploy X</automode:reschedule>

Rules:
- Emit <automode:complete> ONLY when the goal is fully achieved.
- Emit <automode:escalate> when you hit ambiguity, a destructive op, or the same failure 3x.
- Emit <automode:reschedule> when you are waiting on an external job; the scheduler will re-run this turn after the delay.
- Only one sentinel per turn. If none is emitted, the supervisor assumes you want to continue and will run another turn.`;

export function buildTurnPrompt(task: TaskState, turnIndex: number): string {
  if (turnIndex === 1) {
    return [
      `You are running inside OpenClaw automode (autonomous focus mode).`,
      `Task id: ${task.id}`,
      `Goal:`,
      task.goal,
      ``,
      `Context:`,
      `- Working directory: ${task.cwd}`,
      `- Scope paths: ${task.scope.paths.join(", ") || "(unrestricted within cwd)"}`,
      `- Allowed tools: ${task.config.allowedTools.join(", ")}.`,
      `- Denied bash patterns are blocked at the shell layer; do not try to bypass.`,
      `- Max turns: ${task.caps.maxTurns}; max duration: ${task.caps.maxDurationSec}s.`,
      ``,
      CONTROL_SENTINELS,
      ``,
      `Turn 1. Begin.`,
    ].join("\n");
  }
  return [
    `automode turn ${turnIndex} of ${task.caps.maxTurns}.`,
    `Goal (unchanged):`,
    task.goal,
    ``,
    `Progress so far:`,
    task.progressSummary || "(none yet)",
    ``,
    CONTROL_SENTINELS,
    ``,
    `Continue.`,
  ].join("\n");
}

export async function runOneTurn(
  dispatcher: Dispatcher,
  backend: AcpBackend,
  handle: AcpHandle,
  task: TaskState,
  cfg: AutomodeConfig,
  turnIndex: number,
  logger: AnyLogger,
  signal: AbortSignal,
  notifier?: VerboseSink,
): Promise<TurnOutcome> {
  const prompt = buildTurnPrompt(task, turnIndex);
  const requestId = `${task.id}-t${turnIndex}`;
  const startedAt = Date.now();

  let outputText = "";
  let thoughtText = "";
  const events: Array<Record<string, unknown>> = [];
  let eventsDropped = 0;
  let outputDropped = 0;
  let thoughtDropped = 0;
  const toolCalls: TurnRecord["toolCalls"] = [];
  const deniedToolCalls: TurnOutcome["deniedToolCalls"] = [];
  let completeCalled: TurnOutcome["completeCalled"];
  let escalateCalled: TurnOutcome["escalateCalled"];
  let rescheduleCalled: TurnOutcome["rescheduleCalled"];
  let stopReason: string | undefined;
  let errorMessage: string | undefined;

  if (notifier) {
    await notifier.notifyVerbose(task, 2, `▶ turn ${turnIndex} starting (agent: ${task.config.defaultAgent})`);
  }

  // Watchdog: if the stream produces no events for too long, or the whole turn
  // exceeds TURN_WATCHDOG_MS, abort. We don't depend solely on the backend's
  // own timeout.
  const turnStart = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - turnStart > TURN_WATCHDOG_MS) {
      errorMessage = `turn watchdog: exceeded ${TURN_WATCHDOG_MS / 1000}s`;
      logger.warn(`[automode] ${task.id} turn ${turnIndex}: ${errorMessage}`);
      try {
        // Inner AbortController forwarding — the outer signal may not be ours.
      } catch { /* ignore */ }
    }
  }, 30_000).unref?.();

  try {
    let eventCount = 0;
    for await (const ev of dispatcher.runTurn(backend, handle, prompt, requestId, signal)) {
      // Yield to the event loop periodically so heartbeats / other plugins
      // aren't starved on tight bursts.
      eventCount += 1;
      if (eventCount % 100 === 0) {
        await new Promise((r) => setImmediate(r));
      }
      if (Date.now() - turnStart > TURN_WATCHDOG_MS) {
        errorMessage = `turn watchdog: exceeded ${TURN_WATCHDOG_MS / 1000}s`;
        break;
      }
      if (events.length < MAX_EVENTS_PER_TURN) {
        events.push(ev as unknown as Record<string, unknown>);
      } else {
        eventsDropped += 1;
      }
      switch (ev.type) {
        case "text_delta":
          if ((ev.stream ?? "output") === "output") {
            if (outputText.length < MAX_OUTPUT_CHARS_PER_TURN) {
              outputText += ev.text.slice(0, MAX_OUTPUT_CHARS_PER_TURN - outputText.length);
            } else {
              outputDropped += ev.text.length;
            }
          } else {
            if (thoughtText.length < MAX_THOUGHT_CHARS_PER_TURN) {
              thoughtText += ev.text.slice(0, MAX_THOUGHT_CHARS_PER_TURN - thoughtText.length);
            } else {
              thoughtDropped += ev.text.length;
            }
          }
          break;
        case "tool_call": {
          const parsed = parseToolCallText(ev.text ?? ev.title ?? "");
          const superYolo = task.config.autonomy === "super-yolo";
          const decision = superYolo
            ? { allowed: true, reason: "super-yolo: tool guards disabled" }
            : allowDecide(parsed.name, parsed.command, {
                allowedTools: cfg.allowedTools,
                deniedBashPatterns: cfg.deniedBashPatterns,
              });
          toolCalls.push({
            name: parsed.name,
            args: parsed.command,
            allowed: decision.allowed,
            reason: decision.reason,
          });
          if (!decision.allowed) {
            deniedToolCalls.push({ name: parsed.name, reason: decision.reason ?? "denied" });
          }
          if (notifier) {
            const argSnippet = parsed.command ? ` ${parsed.command.split("\n")[0]!.slice(0, 80)}` : "";
            const mark = decision.allowed ? "🔧" : "🚫";
            void notifier.notifyVerbose(task, 2, `${mark} ${parsed.name}${argSnippet}`);
          }
          const toolRaw = ev.text ?? ev.title ?? "";
          const completeHit = detectComplete(toolRaw);
          if (completeHit) completeCalled = completeHit;
          const escalateHit = detectEscalate(toolRaw);
          if (escalateHit) escalateCalled = escalateHit;
          const rescheduleHit = detectReschedule(toolRaw);
          if (rescheduleHit) rescheduleCalled = rescheduleHit;
          break;
        }
        case "done":
          stopReason = ev.stopReason;
          break;
        case "error":
          errorMessage = ev.message;
          break;
        default:
          break;
      }
      if (signal.aborted) break;
    }
  } catch (e) {
    errorMessage = (e as Error).message;
    logger.error(`[automode] turn ${turnIndex} exception: ${errorMessage}`);
  } finally {
    clearInterval(watchdog);
  }

  if (eventsDropped + outputDropped + thoughtDropped > 0) {
    logger.info(
      `[automode] ${task.id} turn ${turnIndex} buffers capped: events+${eventsDropped} output+${outputDropped}c thought+${thoughtDropped}c`,
    );
  }

  // Fallback: scan accumulated output text for sentinels the agent may emit
  // as plain text rather than as a structured tool_call event.
  if (!completeCalled) {
    const hit = detectComplete(outputText);
    if (hit) completeCalled = hit;
  }
  if (!escalateCalled) {
    const hit = detectEscalate(outputText);
    if (hit) escalateCalled = hit;
  }
  if (!rescheduleCalled) {
    const hit = detectReschedule(outputText);
    if (hit) rescheduleCalled = hit;
  }

  const argCap = cfg.auditArgMaxChars ?? 2000;
  const record: TurnRecord = {
    index: turnIndex,
    startedAt,
    endedAt: Date.now(),
    backend: backend.id,
    agent: task.config.defaultAgent,
    requestId,
    prompt: scrub(truncate(prompt, argCap * 2)),
    events: scrubDeep(compressEvents(events)),
    toolCalls: toolCalls.map((t) => ({
      ...t,
      args: t.args ? scrub(truncate(t.args, argCap)) : t.args,
    })),
    stopReason,
    error: errorMessage ? scrub(errorMessage) : errorMessage,
  };

  if (notifier) {
    const durMs = (record.endedAt ?? Date.now()) - record.startedAt;
    const verdict = errorMessage ? `✗ failed: ${errorMessage.slice(0, 120)}` : "✓ ended";
    await notifier.notifyVerbose(task, 1, `${verdict} turn ${turnIndex} in ${Math.round(durMs / 100) / 10}s (${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"})`);
    if (outputText.trim()) {
      await notifier.notifyVerbose(task, 3, `out: ${summarizeOutput(outputText, 400)}`);
    }
    if (thoughtText.trim()) {
      await notifier.notifyVerbose(task, 3, `think: ${summarizeOutput(thoughtText, 300)}`);
    }
  }

  return {
    record,
    outputText: scrub(outputText),
    thoughtText: scrub(thoughtText),
    completeCalled: completeCalled ? { summary: scrub(completeCalled.summary) } : undefined,
    escalateCalled: escalateCalled ? { ...escalateCalled, reason: scrub(escalateCalled.reason) } : undefined,
    rescheduleCalled,
    deniedToolCalls,
  };
}

function compressEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const maxTextLen = 500;
  return events.map((e) => {
    const copy: Record<string, unknown> = { ...e };
    if (typeof copy.text === "string" && copy.text.length > maxTextLen) {
      copy.text = copy.text.slice(0, maxTextLen) + `... [+${copy.text.length - maxTextLen}]`;
    }
    return copy;
  });
}

export function summarizeOutput(text: string, max = 400): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, Math.floor(max * 0.6));
  const tail = trimmed.slice(-Math.floor(max * 0.3));
  return `${head}\n…\n${tail}`;
}

export function updateProgressSummary(prev: string, turn: TurnOutcome): string {
  const latest = summarizeOutput(turn.outputText, 600);
  const block = `turn ${turn.record.index}: ${latest || "(no output)"}`;
  const merged = (prev ? prev + "\n" : "") + block;
  if (merged.length > 4000) {
    const parts = merged.split("\n");
    return parts.slice(-8).join("\n");
  }
  return merged;
}

export type { AcpRuntimeEventLike };
