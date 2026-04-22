import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findOpenclawRoots } from "./sdk-loader.js";
import type { AcpBackend, AcpHandle } from "./dispatcher.js";
import type { AcpRuntimeEventLike } from "../types.js";

type AnyLogger = {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
};

/**
 * The subset of `agentCommand()` surface we consume. We keep this shape
 * narrow so an upstream SDK signature change is easy to adapt to.
 */
type AgentCommandFn = (opts: {
  message: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  abortSignal?: AbortSignal;
  senderIsOwner?: boolean;
  allowModelOverride?: boolean;
  deliver?: boolean;
}) => Promise<{
  payloads: Array<{ text?: string }>;
  meta: {
    durationMs?: number;
    stopReason?: string;
    agentMeta?: {
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      };
      lastCallUsage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      };
    };
    sessionId?: string;
    sessionKey?: string;
    executionTrace?: {
      winnerModel?: string;
      fallbackUsed?: boolean;
    };
    error?: { kind: string; message: string };
  };
}>;

type NativeSdk = {
  agentCommand: AgentCommandFn;
  loadedFrom: string;
};

/**
 * Multi-strategy loader for the native agent runtime. Mirrors the approach
 * used by `src/telegram/sdk.ts`: bare import first (for future openclaw
 * exports), then file-URL import from every discovered install root.
 *
 * The runtime lives at `<openclaw>/dist/plugin-sdk/agent-runtime.js` and
 * re-exports `agentCommand` from `src/agents/agent-command.js`.
 */
export async function loadNativeAgentSdk(
  logger: AnyLogger,
): Promise<NativeSdk | null> {
  const attempts: string[] = [];

  for (const spec of [
    "openclaw/plugin-sdk/agent-runtime",
    "openclaw/plugin-sdk/src/plugin-sdk/agent-runtime.js",
  ]) {
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      const fn = mod.agentCommand as AgentCommandFn | undefined;
      if (typeof fn === "function") {
        return { agentCommand: fn, loadedFrom: `import:${spec}` };
      }
      attempts.push(`${spec}: no agentCommand export`);
    } catch (e) {
      attempts.push(`${spec}: ${(e as Error).message.slice(0, 140)}`);
    }
  }

  for (const root of findOpenclawRoots()) {
    const candidate = path.join(root, "dist", "plugin-sdk", "agent-runtime.js");
    if (!fs.existsSync(candidate)) {
      attempts.push(`${candidate}: missing`);
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(candidate).href)) as Record<string, unknown>;
      const fn = mod.agentCommand as AgentCommandFn | undefined;
      if (typeof fn === "function") {
        logger.info(`[automode] native agent SDK loaded from ${candidate}`);
        return { agentCommand: fn, loadedFrom: candidate };
      }
      attempts.push(`${candidate}: no agentCommand export`);
    } catch (e) {
      attempts.push(`${candidate}: ${(e as Error).message.slice(0, 140)}`);
    }
  }

  logger.warn(
    `[automode] native agent SDK not found — openclaw-native backend unavailable.\n  Attempts:\n  ${attempts.join("\n  ")}`,
  );
  return null;
}

/**
 * Rough cost estimator per token-usage snapshot. Real pricing per model is
 * complex and provider-dependent; we intentionally under-count rather than
 * over-estimate so users with a budget don't get hit with surprise caps.
 *
 * For accurate per-model pricing we'd need a pricing table; for now we apply
 * a conservative blended rate ($0.002 / 1K input, $0.006 / 1K output) that
 * matches typical Kimi / mid-tier model rates within ~2x.
 */
function estimateTurnCostUsd(
  usage:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined,
): number {
  if (!usage) return 0;
  const inputTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) * 0.1;
  const outputTokens = usage.output ?? 0;
  return (inputTokens / 1000) * 0.002 + (outputTokens / 1000) * 0.006;
}

/**
 * In-memory session registry. Native agent sessions are identified by
 * `{sessionId, sessionKey}`; we look them up by the automode `sessionKey`
 * (e.g. `automode-<taskId>`) so resumed tasks keep talking to the same
 * persisted transcript on disk.
 */
type NativeSessionRec = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  cwd?: string;
  abort?: AbortController;
  cumulativeCostUsd: number;
};

/**
 * Build an `AcpBackend`-shaped adapter that dispatches to the native runtime
 * instead of an ACP backend. The fields we don't use (runtimeSessionName,
 * backendSessionId, etc.) are stubbed out with sentinel strings — the ACP
 * interface expects them but automode's code path only reads `sessionKey`.
 */
export function makeNativeBackend(
  sdk: NativeSdk,
  logger: AnyLogger,
): AcpBackend {
  const sessions = new Map<string, NativeSessionRec>();

  const backend: AcpBackend = {
    id: "openclaw-native",
    runtime: {
      async ensureSession(input) {
        let rec = sessions.get(input.sessionKey);
        if (!rec) {
          // sessionId starts blank; the native runtime assigns one on the
          // first agentCommand() call and we capture it via meta.sessionId.
          rec = {
            sessionId: input.resumeSessionId ?? "",
            sessionKey: input.sessionKey,
            agentId: input.agent,
            cwd: input.cwd,
            cumulativeCostUsd: 0,
          };
          sessions.set(input.sessionKey, rec);
        }
        const handle: AcpHandle = {
          sessionKey: input.sessionKey,
          backend: "openclaw-native",
          runtimeSessionName: `native:${input.agent}`,
          cwd: input.cwd,
          backendSessionId: rec.sessionId || undefined,
          agentSessionId: rec.sessionId || undefined,
        };
        return handle;
      },

      async *runTurn(input) {
        const rec = sessions.get(input.handle.sessionKey);
        if (!rec) {
          yield { type: "error", message: `native session '${input.handle.sessionKey}' not initialised` } as AcpRuntimeEventLike;
          return;
        }
        const ab = new AbortController();
        const onAbort = () => ab.abort();
        if (input.signal) {
          if (input.signal.aborted) ab.abort();
          else input.signal.addEventListener("abort", onAbort, { once: true });
        }
        rec.abort = ab;
        try {
          const result = await sdk.agentCommand({
            message: input.text,
            agentId: rec.agentId,
            sessionId: rec.sessionId || undefined,
            sessionKey: rec.sessionKey,
            workspaceDir: rec.cwd,
            abortSignal: ab.signal,
            // Treat automode-initiated runs as owner-equivalent; this lets
            // the native runtime apply per-agent authorization defaults
            // without blocking. Users who want stricter gating should run
            // via the ACP backend path instead.
            senderIsOwner: true,
            allowModelOverride: false,
            // We consume the payload directly; the runtime shouldn't also
            // deliver it via the outbound channel the caller registered.
            deliver: false,
          });
          // Capture the sessionId the runtime assigned so subsequent turns
          // resume the same transcript.
          if (result.meta.sessionId) rec.sessionId = result.meta.sessionId;

          // Error path: surface as an ACP-style error event so the scheduler
          // treats it consistently with ACP backend failures.
          if (result.meta.error) {
            yield {
              type: "error",
              message: `${result.meta.error.kind}: ${result.meta.error.message}`,
            } as AcpRuntimeEventLike;
            return;
          }

          // Emit one text_delta per payload so UIs that watch deltas still
          // see the body. Native runtime is one-shot; we can't interleave.
          for (const p of result.payloads ?? []) {
            if (p.text) {
              yield { type: "text_delta", text: p.text, stream: "output" } as AcpRuntimeEventLike;
            }
          }

          const usage = result.meta.agentMeta?.lastCallUsage ?? result.meta.agentMeta?.usage;
          const turnCost = estimateTurnCostUsd(usage);
          rec.cumulativeCostUsd += turnCost;
          const winner = result.meta.executionTrace?.winnerModel;
          if (result.meta.executionTrace?.fallbackUsed) {
            logger.info(
              `[automode] native session ${rec.sessionKey}: fallback model used (winner=${winner ?? "?"})`,
            );
          }

          yield {
            type: "done",
            stopReason: result.meta.stopReason ?? "completed",
            // Attach usage + cost hints so downstream code (cost ledger,
            // budget enforcement) can pick them up.
            cost: { totalUsd: rec.cumulativeCostUsd, turnUsd: turnCost },
            usage,
          } as AcpRuntimeEventLike;
        } catch (e) {
          yield {
            type: "error",
            message: (e as Error).message,
          } as AcpRuntimeEventLike;
        } finally {
          if (input.signal) input.signal.removeEventListener("abort", onAbort);
          rec.abort = undefined;
        }
      },

      async getStatus({ handle }) {
        const rec = sessions.get(handle.sessionKey);
        return {
          sessionId: rec?.sessionId,
          totalCostUsd: rec?.cumulativeCostUsd ?? 0,
        };
      },

      async cancel({ handle, reason }) {
        const rec = sessions.get(handle.sessionKey);
        if (rec?.abort) {
          rec.abort.abort();
          logger.info(
            `[automode] native session ${rec.sessionKey} cancelled${reason ? `: ${reason}` : ""}`,
          );
        }
      },

      async close({ handle, reason }) {
        const rec = sessions.get(handle.sessionKey);
        if (rec?.abort) rec.abort.abort();
        sessions.delete(handle.sessionKey);
        logger.info(
          `[automode] native session ${handle.sessionKey} closed${reason ? `: ${reason}` : ""}`,
        );
      },
    },
    healthy: () => true,
  };
  return backend;
}
