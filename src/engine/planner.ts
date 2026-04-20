import type { AcpBackend, AcpHandle } from "../agents/dispatcher.js";
import type { Dispatcher } from "../agents/dispatcher.js";
import type { PlannerDecision, TaskState } from "../types.js";

type AnyLogger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

const PLANNER_SYSTEM = `You are the automode planner. Analyse the user's goal and return STRICT JSON with this shape:

{
  "parallel": boolean,
  "confidence": number,          // 0..1 — how confident you are in this plan
  "subtasks": [
    { "id": string, "agent": string, "goal": string, "dependsOn": [string, ...] }
  ],
  "rationale": string
}

Rules:
- Return JSON ONLY, no prose, no code fences.
- If the goal is a single cohesive task, return "parallel": false and ONE subtask whose id is "main".
- If the goal naturally splits (independent areas of a codebase, independent channels, etc.), return "parallel": true with up to 3 subtasks.
- "agent" should be a short role name such as "frontend", "backend", "test", "docs", "research", or "general".
- "confidence" < 0.7 means the planner is unsure; the orchestrator will ask the user what to do.`;

function extractJson(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return null;
}

export async function plan(
  dispatcher: Dispatcher,
  backend: AcpBackend,
  handle: AcpHandle,
  task: TaskState,
  logger: AnyLogger,
  signal: AbortSignal,
): Promise<PlannerDecision> {
  const prompt = [
    PLANNER_SYSTEM,
    "",
    `GOAL:\n${task.goal}`,
    "",
    `cwd: ${task.cwd}`,
    `task id: ${task.id}`,
    `default agent: ${task.config.defaultAgent}`,
    "",
    "Respond with JSON only.",
  ].join("\n");

  let buf = "";
  const requestId = `planner-${task.id}`;
  for await (const ev of dispatcher.runTurn(backend, handle, prompt, requestId, signal)) {
    if (ev.type === "text_delta" && (ev.stream ?? "output") === "output") buf += ev.text;
    else if (ev.type === "done") break;
    else if (ev.type === "error") throw new Error(`planner error: ${ev.message}`);
  }
  const jsonText = extractJson(buf);
  if (!jsonText) {
    logger.warn(`[automode] planner returned no JSON; falling back to single-agent. raw=${buf.slice(0, 200)}`);
    return fallback(task, 0.3, "planner did not return JSON");
  }
  try {
    const parsed = JSON.parse(jsonText) as Partial<PlannerDecision>;
    const subtasks = Array.isArray(parsed.subtasks)
      ? parsed.subtasks.map((s, i) => ({
          id: String(s.id ?? `sub${i + 1}`),
          agent: String(s.agent ?? task.config.defaultAgent),
          goal: String(s.goal ?? task.goal),
          dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
        }))
      : [];
    if (subtasks.length === 0) return fallback(task, 0.4, "planner produced no subtasks");
    const confidence = clampNumber(parsed.confidence, 0, 1, 0.5);
    return {
      parallel: Boolean(parsed.parallel) && subtasks.length > 1,
      confidence,
      subtasks,
      rationale: String(parsed.rationale ?? ""),
    };
  } catch (e) {
    logger.warn(`[automode] planner JSON parse failed: ${(e as Error).message}`);
    return fallback(task, 0.3, "planner JSON parse failed");
  }
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function fallback(task: TaskState, confidence: number, rationale: string): PlannerDecision {
  return {
    parallel: false,
    confidence,
    subtasks: [{ id: "main", agent: task.config.defaultAgent, goal: task.goal, dependsOn: [] }],
    rationale,
  };
}
