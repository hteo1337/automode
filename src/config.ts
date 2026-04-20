import os from "node:os";
import path from "node:path";
import { discoverAcpxAgents } from "./agents/discovery.js";
import { isAutonomyLevel } from "./engine/autonomy.js";
import type { AutomodeConfig } from "./types.js";

export const DEFAULT_CONFIG: AutomodeConfig = {
  defaultAgent: "auto",
  fallbackAgents: ["auto"],
  agentRoleMap: {
    general: "auto",
    frontend: "auto",
    backend: "auto",
    test: "auto",
    research: "auto",
    docs: "auto",
    main: "auto",
  },
  retryOnErrors: {
    rateLimited: true,
    unhealthy: true,
    notFound: true,
    timeout: true,
    network: true,
  },
  healthProbeEnabled: false,
  maxFallbacks: 3,
  verbosity: 1,
  autonomy: "normal",
  backend: "claude-acp",
  maxTurns: 50,
  maxDurationSec: 3600,
  maxParallel: 3,
  parallelismPolicy: "auto",
  planFirstThreshold: 0.7,
  allowedTools: [
    "Read", "Grep", "Glob", "Edit", "Write",
    "TaskCreate", "TaskUpdate", "TaskList",
    "NotebookEdit", "Bash",
  ],
  deniedBashPatterns: [
    "^\\s*rm\\s+-rf\\s+[/~]",
    "^\\s*sudo\\b",
    "git\\s+push\\s+(-f|--force)",
    "git\\s+reset\\s+--hard",
    "curl\\b.*\\|\\s*(bash|sh)\\b",
    "chmod\\s+777",
    "^\\s*dd\\s+if=",
    "mkfs\\.",
    ":\\(\\)\\{",
    "\\bkill\\s+-9\\s+1\\b",
  ],
  telegram: { enabled: true, accountId: "default" },
  notifiers: {
    slack: { enabled: false },
    discord: { enabled: false },
  },
  escalationTimeoutSec: 300,
  agentRegistryPaths: ["~/.claude/agents", "~/.openclaw/subagents"],
  stateDir: "~/.openclaw/automode",
  schedulerTickMs: 5000,
  discoveredAcpxAgents: [],
  maxCostUsd: 0,
  auditArgMaxChars: 2000,
  retryBackoffMs: 500,
  strictOwner: false,
  defaultMode: {
    enabled: false,
    gate: "verbOrLength",
    minWords: 6,
    verbs: [
      "fix", "sort", "handle", "refactor", "implement", "build", "run",
      "check", "find", "debug", "ship", "watch", "clean", "process",
      "merge", "review", "deploy", "test", "generate", "update", "upgrade",
      "investigate", "analyze", "migrate", "write",
    ],
  },
};

export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Build the effective plugin config. Optionally reads the OpenClaw root config
 * (passed to plugins via `api.config`) to auto-discover acpx agents for the
 * "auto" sentinel used by defaultAgent / fallbackAgents / agentRoleMap.
 */
export function resolveConfig(raw: unknown, openclawRootConfig?: unknown): AutomodeConfig {
  const r = isObject(raw) ? raw : {};
  const tgRaw = isObject(r.telegram) ? r.telegram : {};
  const retryRaw = isObject(r.retryOnErrors) ? r.retryOnErrors : {};
  const roleRaw = isObject(r.agentRoleMap) ? r.agentRoleMap : {};
  const verbosityRaw = Number(r.verbosity ?? DEFAULT_CONFIG.verbosity);
  const verbosity = Number.isFinite(verbosityRaw)
    ? (Math.min(3, Math.max(0, Math.floor(verbosityRaw))) as 0 | 1 | 2 | 3)
    : DEFAULT_CONFIG.verbosity;
  const autonomy = isAutonomyLevel(r.autonomy) ? r.autonomy : DEFAULT_CONFIG.autonomy;
  const defaultModeRaw = isObject(r.defaultMode) ? r.defaultMode : {};
  const defaultMode = {
    ...DEFAULT_CONFIG.defaultMode,
    ...defaultModeRaw,
    verbs: Array.isArray(defaultModeRaw.verbs)
      ? (defaultModeRaw.verbs as unknown[]).filter((v): v is string => typeof v === "string")
      : DEFAULT_CONFIG.defaultMode.verbs,
  } as AutomodeConfig["defaultMode"];
  const out: AutomodeConfig = {
    ...DEFAULT_CONFIG,
    ...r,
    verbosity,
    autonomy,
    defaultMode,
    telegram: { ...DEFAULT_CONFIG.telegram, ...tgRaw },
    retryOnErrors: { ...DEFAULT_CONFIG.retryOnErrors, ...retryRaw } as AutomodeConfig["retryOnErrors"],
    agentRoleMap: { ...DEFAULT_CONFIG.agentRoleMap, ...coerceStringMap(roleRaw) },
    fallbackAgents: Array.isArray(r.fallbackAgents) ? r.fallbackAgents.map(String) : DEFAULT_CONFIG.fallbackAgents,
  };
  out.stateDir = expandHome(out.stateDir);
  out.agentRegistryPaths = (out.agentRegistryPaths ?? []).map(expandHome);
  const { ids } = discoverAcpxAgents(openclawRootConfig);
  out.discoveredAcpxAgents = ids;
  return out;
}

function coerceStringMap(x: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(x)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
