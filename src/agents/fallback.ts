import { expandAuto } from "./discovery.js";

export type RetryPolicy = {
  rateLimited: boolean;
  unhealthy: boolean;
  notFound: boolean;
  timeout: boolean;
  network: boolean;
};

export type ErrorKind =
  | "rateLimited"
  | "unhealthy"
  | "notFound"
  | "timeout"
  | "network"
  | "fatal";

export type ErrorClassification = {
  kind: ErrorKind;
  retryable: boolean;
  message: string;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  rateLimited: true,
  unhealthy: true,
  notFound: true,
  timeout: true,
  network: true,
};

export function classifyError(err: unknown, policy: RetryPolicy): ErrorClassification {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();
  const m = message.toLowerCase();

  if (/\b429\b|rate.?limit|too many req/.test(m)) {
    return { kind: "rateLimited", retryable: policy.rateLimited, message };
  }
  if (/\b5\d\d\b|overload|unavailable|unhealthy|not healthy|bad gateway/.test(m)) {
    return { kind: "unhealthy", retryable: policy.unhealthy, message };
  }
  if (/not.?found|unknown agent|\b404\b|no such agent/.test(m)) {
    return { kind: "notFound", retryable: policy.notFound, message };
  }
  if (/timeout|etimedout|deadline/.test(m)) {
    return { kind: "timeout", retryable: policy.timeout, message };
  }
  if (/econnrefused|enotfound|econnreset|network|socket|dns/.test(m)) {
    return { kind: "network", retryable: policy.network, message };
  }
  return { kind: "fatal", retryable: false, message };
}

export type BuildChainOpts = {
  preferred: string;                // e.g. "auto" | concrete acpx id
  explicitFallbacks: string[];      // user-configured fallbackAgents
  discovered: string[];             // output of discoverAcpxAgents().ids
  defaultHint?: string;             // final safety net (e.g. the original defaultAgent)
  maxLength?: number;               // hard cap, defaults to 6
};

/**
 * Build the ordered, deduplicated agent chain to attempt.
 *
 * Order:
 *   1. preferred (expanded if "auto")
 *   2. explicitFallbacks (each expanded if "auto")
 *   3. any remaining discovered agents not yet listed
 *   4. defaultHint (if concrete and still not listed)
 *
 * The result is never empty — if nothing else is available, the preferred id
 * is returned even when it's "auto" with no discovery (caller will then fail
 * explicitly rather than silently).
 */
export function buildAgentChain(opts: BuildChainOpts): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    chain.push(id);
  };
  for (const x of expandAuto(opts.preferred, opts.discovered)) push(x);
  for (const f of opts.explicitFallbacks) {
    for (const x of expandAuto(f, opts.discovered)) push(x);
  }
  for (const d of opts.discovered) push(d);
  if (opts.defaultHint && opts.defaultHint !== "auto") push(opts.defaultHint);

  const cap = Math.max(1, opts.maxLength ?? 6);
  const capped = chain.slice(0, cap);
  if (capped.length === 0) capped.push(opts.preferred);
  return capped;
}

/** Map a planner-emitted role label to a concrete acpx agent id. */
export function mapRoleToAgent(
  roleOrId: string,
  discovered: string[],
  roleMap: Record<string, string>,
  defaultAgent: string,
): string {
  if (discovered.includes(roleOrId)) return roleOrId;
  const mapped = roleMap[roleOrId];
  if (mapped && mapped !== "auto") return mapped;
  if (mapped === "auto" && discovered.length > 0) return discovered[0]!;
  if (defaultAgent && defaultAgent !== "auto") return defaultAgent;
  return discovered[0] ?? roleOrId;
}
