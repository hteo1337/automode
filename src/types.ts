export type RetryPolicyConfig = {
  rateLimited: boolean;
  unhealthy: boolean;
  notFound: boolean;
  timeout: boolean;
  network: boolean;
};

export type VerbosityLevel = 0 | 1 | 2 | 3;

/**
 * Which ACP-style runtime backend dispatches a task's turns.
 *
 *   acpx           — the bundled acpx extension that wraps CLI agents
 *   claude-acp     — the optional `claude-acp` plugin (persistent Claude pool)
 *   openclaw-native — automode's adapter over `plugin-sdk/agent-runtime`
 *                    (agentCommand()), used for agents declared in
 *                    openclaw.json's `agents.list[]` (e.g. Kimi-via-Fireworks).
 */
export type BackendId = "acpx" | "claude-acp" | "openclaw-native";

/**
 * Autonomy level controls how often the task escalates to a human AND
 * whether the tool allow/deny rails apply at all.
 *
 * - strict:     escalate on low-confidence plans + repeated failures (≥2)
 * - normal:     escalate on low-confidence plans + repeated failures (≥3) — default
 * - high:       auto-approve plan-first and low-confidence; only escalate on
 *               denied tools or repeated failures (≥5)
 * - yolo:       auto-approve every soft decision; the **tool denylist is
 *               still enforced** — yolo can't cross it.
 * - super-yolo: NO GUARDS. Bypasses path-scope, bash denylist, tool allowlist,
 *               and escalations. Only use on a throwaway machine or VM.
 */
export type AutonomyLevel =
  | "strict"
  | "normal"
  | "high"
  | "yolo"
  | "super-yolo";

export type AutomodeConfig = {
  defaultAgent: string;                     // "auto" | concrete acpx id
  fallbackAgents: string[];                 // each: "auto" | concrete id
  agentRoleMap: Record<string, string>;     // planner role → acpx id ("auto" allowed)
  retryOnErrors: RetryPolicyConfig;
  healthProbeEnabled: boolean;
  maxFallbacks: number;
  verbosity: VerbosityLevel;                // 0 silent … 3 debug
  autonomy: AutonomyLevel;
  /** If true, non-owners can only inspect tasks (not stop/pause/resume). */
  strictOwner: boolean;
  /** Host-wide 'default to automode' behaviour. Overridden by per-chat prefs. */
  defaultMode: {
    enabled: boolean;
    gate: "any" | "verb" | "length" | "verbOrLength";
    minWords: number;
    verbs: string[];
  };
  backend: BackendId;
  maxTurns: number;
  maxDurationSec: number;
  maxParallel: number;
  parallelismPolicy: "auto" | "ask" | "never" | "always";
  planFirstThreshold: number;
  allowedTools: string[];
  deniedBashPatterns: string[];
  telegram: { enabled: boolean; accountId: string; chatId?: string };
  notifiers?: {
    slack?: { enabled: boolean; channel?: string; accountId?: string };
    discord?: { enabled: boolean; channel?: string; accountId?: string };
  };
  escalationTimeoutSec: number;
  /** Max USD spend before task auto-caps with reason="cost". 0 disables. */
  maxCostUsd: number;
  /** Per-record cap for tool-call args in audit (characters). */
  auditArgMaxChars: number;
  /** Base delay between fallback retries; doubles per attempt. */
  retryBackoffMs: number;
  agentRegistryPaths: string[];
  stateDir: string;
  schedulerTickMs: number;
  /** Populated at plugin boot from acpx config; not user-editable. */
  discoveredAcpxAgents: string[];
  /** Populated at plugin boot from openclaw `agents.list[]`; not user-editable. */
  discoveredNativeAgents: string[];
  /**
   * Per-id origin so the dispatcher picks the right backend ("acpx" /
   * "claude-acp" for ACP agents, "openclaw-native" for agents.list[]).
   */
  agentOriginById: Record<string, "acpx" | "native">;
};

export type TaskMode = "goal" | "interval" | "paced" | "hybrid";

export type TaskStatus =
  | "pending"
  | "planning"
  | "running"
  | "waiting"
  | "escalating"
  | "paused"
  | "done"
  | "capped"
  | "failed"
  | "stopped";

export type TurnRecord = {
  index: number;
  startedAt: number;
  endedAt?: number;
  backend: string;
  agent: string;
  requestId: string;
  prompt: string;
  events: Array<Record<string, unknown>>;
  toolCalls: Array<{ name: string; args?: string; allowed: boolean; reason?: string }>;
  stopReason?: string;
  error?: string;
};

export type Subtask = {
  id: string;
  agent: string;
  goal: string;
  dependsOn: string[];
  status: TaskStatus;
  turns: TurnRecord[];
};

export type PlannerDecision = {
  parallel: boolean;
  confidence: number;
  subtasks: Array<{ id: string; agent: string; goal: string; dependsOn?: string[] }>;
  rationale: string;
  /** 3-6 word human-readable title the planner derives from the goal. */
  title?: string;
};

export type Escalation = {
  id: string;
  taskId: string;
  reason: string;
  severity: "info" | "warn" | "block";
  raisedAt: number;
  resolvedAt?: number;
  decision?: "approve" | "deny" | "modify" | "stop";
  note?: string;
  telegramMessageId?: number;
};

export type TaskOwner = {
  channel?: string;
  senderId?: string;
};

export type TaskState = {
  id: string;
  version: 1;
  goal: string;
  /**
   * Short human-readable name for the task. Set to a heuristic clip of
   * the goal on task creation, then overwritten by the planner when turn
   * 0 finishes with a cleaner 3-6 word title.
   */
  title?: string;
  /** Identity of whoever started the task (set from CommandCtx). */
  owner?: TaskOwner;
  /** Cumulative USD cost observed from backend.runtime.getStatus snapshots. */
  totalCostUsd?: number;
  dryRun?: boolean;
  onDone?: string;
  onFail?: string;
  templateName?: string;
  /** Sibling task ids if this task is part of a shadow comparison run. */
  shadowPeers?: string[];
  mode: TaskMode;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  cwd: string;
  scope: { paths: string[] };
  caps: { maxTurns: number; maxDurationSec: number };
  config: {
    defaultAgent: string;
    backend: BackendId;
    allowedTools: string[];
    deniedBashPatterns: string[];
    parallelismPolicy: "auto" | "ask" | "never" | "always";
    maxParallel: number;
    planFirstThreshold: number;
    verbosity: VerbosityLevel;
    autonomy: AutonomyLevel;
  };
  interval?: { everySec: number; lastFiredAt?: number };
  nextFireAt?: number;
  planFirst: boolean;
  planner?: PlannerDecision;
  progressSummary: string;
  turnCount: number;
  subtasks?: Subtask[];
  escalations: Escalation[];
  stopReason?: string;
  error?: string;
  outcomeSummary?: string;
  telegram?: {
    chatId?: string;
    accountId?: string;
    startMessageId?: number;
    progressMessageId?: number;
    /**
     * When set, `notifyProgress` edits `progressMessageId` with a pinned
     * "tailing" render that includes a Stop-tailing button. Cleared by
     * the untail handler (or task completion).
     */
    tailActive?: boolean;
  };
};

export type StartOptions = {
  goal: string;
  mode?: TaskMode;
  planFirst?: boolean;
  intervalSec?: number;
  agent?: string;
  backend?: BackendId;
  maxTurns?: number;
  maxDurationSec?: number;
  maxCostUsd?: number;
  cwd?: string;
  scopePaths?: string[];
  chatId?: string;
  verbosity?: VerbosityLevel;
  owner?: TaskOwner;
  autonomy?: AutonomyLevel;
  dryRun?: boolean;
  /** Slash command (with args) to dispatch when the task reaches `done`. */
  onDone?: string;
  /** Slash command to dispatch when the task reaches `failed` / `capped`. */
  onFail?: string;
  /** Name of the template this task was started from (for audit). */
  templateName?: string;
};

export type SupervisorDecision =
  | { kind: "continue"; note?: string }
  | { kind: "reschedule"; delaySec: number; note?: string }
  | { kind: "done"; summary: string }
  | { kind: "capped"; reason: "turns" | "duration" | "cost" }
  | { kind: "failed"; error: string }
  | { kind: "escalate"; reason: string; severity: "info" | "warn" | "block" }
  | { kind: "stopped" };

export type AcpRuntimeEventLike =
  | { type: "text_delta"; text: string; stream?: "output" | "thought"; tag?: string }
  | { type: "status"; text: string; tag?: string }
  | { type: "tool_call"; text: string; tag?: string; toolCallId?: string; status?: string; title?: string }
  | { type: "done"; stopReason?: string }
  | { type: "error"; message: string; code?: string; retryable?: boolean };
