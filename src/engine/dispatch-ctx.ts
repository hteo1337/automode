import type { AutomodeConfig } from "../types.js";
import type { DispatchContext } from "../agents/dispatcher.js";

export type BuildDispatchCtxArgs = {
  taskId: string;
  cwd: string;
  preferredAgent: string;      // "auto" allowed; falls back to cfg.defaultAgent if empty
  cfg: AutomodeConfig;
  env?: Record<string, string>;
};

/**
 * Fold the live plugin config into a DispatchContext so every caller passes
 * the same retry/fallback policy without duplicating fields.
 */
export function buildDispatchContext(args: BuildDispatchCtxArgs): DispatchContext {
  const preferred = args.preferredAgent || args.cfg.defaultAgent || "auto";
  return {
    taskId: args.taskId,
    cwd: args.cwd,
    preferredAgent: preferred,
    explicitFallbacks: args.cfg.fallbackAgents,
    discoveredAgents: args.cfg.discoveredAcpxAgents,
    defaultHint: args.cfg.defaultAgent,
    backendId: args.cfg.backend,
    env: args.env,
    healthProbeEnabled: args.cfg.healthProbeEnabled,
    retryPolicy: args.cfg.retryOnErrors,
    maxFallbacks: args.cfg.maxFallbacks,
    backoffMs: args.cfg.retryBackoffMs,
  };
}
