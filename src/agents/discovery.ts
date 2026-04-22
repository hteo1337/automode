/**
 * Agent auto-discovery across the two sources OpenClaw exposes to plugins:
 *
 *   1. `plugins.entries.acpx.config.agents`  — ACP-wrapped CLIs
 *   2. `agents.list[]`                       — native openclaw agents
 *      (each `{ id, model: { primary, fallbacks } }`)
 *
 * Both feed into automode's `"auto"` sentinel. Consumers can inspect
 * `originById` to pick a backend (native agents → "openclaw-native",
 * ACP agents → "acpx" or "claude-acp").
 */
export type AgentOrigin = "acpx" | "native";

export type DiscoveredAgents = {
  /** Flat list, ACP first then native, deduped (ACP wins on collision). */
  ids: string[];
  byCommand: Record<string, string>;
  /** Per-id origin so callers can pick the right backend. */
  originById: Record<string, AgentOrigin>;
  acpxIds: string[];
  nativeIds: string[];
};

type LooseOpenclawConfig = {
  plugins?: {
    entries?: {
      acpx?: {
        config?: {
          agents?: Record<string, unknown>;
        };
      };
    };
  };
  agents?: {
    list?: Array<{ id?: unknown; model?: unknown }>;
  };
};

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function discoverAcpxAgents(openclawConfig: unknown): DiscoveredAgents {
  const cfg = openclawConfig as LooseOpenclawConfig | undefined;
  const acpxIds: string[] = [];
  const byCommand: Record<string, string> = {};
  const originById: Record<string, AgentOrigin> = {};

  const acpxAgents = cfg?.plugins?.entries?.acpx?.config?.agents;
  if (isObject(acpxAgents)) {
    for (const [name, entry] of Object.entries(acpxAgents)) {
      if (typeof name !== "string" || !name.trim()) continue;
      acpxIds.push(name);
      originById[name] = "acpx";
      if (isObject(entry) && typeof entry.command === "string") {
        byCommand[name] = entry.command;
      }
    }
  }

  // `agents.list[]`: native openclaw agents. An ACP wrapper with the same
  // name wins the origin label (users have explicitly opted them into ACP),
  // but we still surface the native id in `nativeIds` for visibility.
  const nativeIds: string[] = [];
  const rawList = cfg?.agents?.list;
  if (Array.isArray(rawList)) {
    for (const entry of rawList) {
      if (!isObject(entry)) continue;
      const id = entry.id;
      if (typeof id !== "string" || !id.trim()) continue;
      nativeIds.push(id);
      if (!(id in originById)) originById[id] = "native";
    }
  }

  const ids: string[] = [...acpxIds];
  for (const id of nativeIds) if (!ids.includes(id)) ids.push(id);

  return { ids, byCommand, originById, acpxIds, nativeIds };
}

/**
 * Expand the sentinel "auto" into the ordered list of discovered agents
 * (ACP first, then native — ACP is preferred when both are available
 * because it has richer streaming + session semantics).
 * - A concrete agent id passes through unchanged.
 * - "auto" expands to every discovered id.
 * - Unknown ids pass through unchanged (user may rely on a runtime that
 *   resolves them outside of the discovery surface).
 */
export function expandAuto(agentOrAuto: string, discovered: string[]): string[] {
  if (agentOrAuto === "auto") return [...discovered];
  return [agentOrAuto];
}

/**
 * Pick the backend id to dispatch a given agent to based on its origin.
 * Falls back to the caller's default when the id isn't in the registry
 * (e.g. user set a custom agent name that automode can't classify).
 */
export function backendForAgent(
  agentId: string,
  originById: Record<string, AgentOrigin>,
  defaultBackend: string,
): string {
  const origin = originById[agentId];
  if (origin === "native") return "openclaw-native";
  if (origin === "acpx") return defaultBackend === "openclaw-native" ? "acpx" : defaultBackend;
  return defaultBackend;
}
