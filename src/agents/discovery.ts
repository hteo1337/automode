/**
 * Acpx agent auto-discovery.
 *
 * Reads `plugins.entries.acpx.config.agents` from the OpenClaw root config (the
 * shape that `api.config` exposes to plugins) and returns the list of agent ids
 * the user has already configured. This lets automode's `defaultAgent: "auto"`
 * and `fallbackAgents: ["auto"]` work without any per-host tweaking.
 */
export type DiscoveredAgents = {
  ids: string[];
  byCommand: Record<string, string>;
};

type LooseAcpxConfig = {
  plugins?: {
    entries?: {
      acpx?: {
        config?: {
          agents?: Record<string, unknown>;
        };
      };
    };
  };
};

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function discoverAcpxAgents(openclawConfig: unknown): DiscoveredAgents {
  const cfg = openclawConfig as LooseAcpxConfig | undefined;
  const agents = cfg?.plugins?.entries?.acpx?.config?.agents;
  if (!isObject(agents)) return { ids: [], byCommand: {} };

  const ids: string[] = [];
  const byCommand: Record<string, string> = {};
  for (const [name, entry] of Object.entries(agents)) {
    if (typeof name !== "string" || !name.trim()) continue;
    ids.push(name);
    if (isObject(entry) && typeof entry.command === "string") {
      byCommand[name] = entry.command;
    }
  }
  return { ids, byCommand };
}

/**
 * Expand the sentinel "auto" into the ordered list of discovered acpx agents.
 * - A concrete agent id passes through unchanged.
 * - "auto" expands to every discovered id.
 * - Unknown ids pass through unchanged (user may rely on a runtime that
 *   resolves them outside of acpx).
 */
export function expandAuto(agentOrAuto: string, discovered: string[]): string[] {
  if (agentOrAuto === "auto") return [...discovered];
  return [agentOrAuto];
}
