import type { AutomodeConfig, BackendId } from "../types.js";
import type { DispatchContext } from "../agents/dispatcher.js";

export type BuildDispatchCtxArgs = {
  taskId: string;
  cwd: string;
  preferredAgent: string;      // "auto" allowed; falls back to cfg.defaultAgent if empty
  cfg: AutomodeConfig;
  env?: Record<string, string>;
  /**
   * Backend chosen at task-start time (lives on `TaskState.config.backend`).
   * Overrides `cfg.backend` so a task that was started with
   * `--backend=openclaw-native` keeps using it across resumes even if the
   * plugin's `cfg.backend` changed in between.
   */
  taskBackend?: BackendId;
};

/**
 * Fold the live plugin config into a DispatchContext so every caller passes
 * the same retry/fallback policy without duplicating fields.
 *
 * Agent discovery now covers both surfaces:
 *   - ACP wrappers (acpx config)
 *   - Native openclaw agents (openclaw.json agents.list[])
 * The dispatcher uses this combined list when expanding the "auto" sentinel
 * and the per-agent `agentOriginById` to route each candidate to the right
 * backend.
 */
export function buildDispatchContext(args: BuildDispatchCtxArgs): DispatchContext {
  const preferred = args.preferredAgent || args.cfg.defaultAgent || "auto";
  const discovered = [
    ...args.cfg.discoveredAcpxAgents,
    ...args.cfg.discoveredNativeAgents.filter((id) => !args.cfg.discoveredAcpxAgents.includes(id)),
  ];
  return {
    taskId: args.taskId,
    cwd: args.cwd,
    preferredAgent: preferred,
    explicitFallbacks: args.cfg.fallbackAgents,
    discoveredAgents: discovered,
    defaultHint: args.cfg.defaultAgent,
    backendId: args.taskBackend ?? args.cfg.backend,
    agentOriginById: args.cfg.agentOriginById,
    env: args.env,
    healthProbeEnabled: args.cfg.healthProbeEnabled,
    retryPolicy: args.cfg.retryOnErrors,
    maxFallbacks: args.cfg.maxFallbacks,
    backoffMs: args.cfg.retryBackoffMs,
  };
}
