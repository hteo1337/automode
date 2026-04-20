import type { AcpRuntimeEventLike } from "../types.js";
import {
  buildAgentChain,
  classifyError,
  DEFAULT_RETRY_POLICY,
  type ErrorClassification,
  type RetryPolicy,
} from "./fallback.js";
import { importSdk } from "./sdk-loader.js";

const ACP_RUNTIME_SPEC = "openclaw/plugin-sdk/acp-runtime";

type AnyLogger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export type AcpHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};

export type AcpBackend = {
  id: string;
  runtime: {
    ensureSession(input: {
      sessionKey: string;
      agent: string;
      mode: "persistent" | "oneshot";
      resumeSessionId?: string;
      cwd?: string;
      env?: Record<string, string>;
    }): Promise<AcpHandle>;
    runTurn(input: {
      handle: AcpHandle;
      text: string;
      mode: "prompt" | "steer";
      requestId: string;
      signal?: AbortSignal;
    }): AsyncIterable<AcpRuntimeEventLike>;
    getStatus?(input: { handle: AcpHandle; signal?: AbortSignal }): Promise<unknown>;
    cancel(input: { handle: AcpHandle; reason?: string }): Promise<void>;
    close(input: { handle: AcpHandle; reason: string }): Promise<void>;
  };
  healthy?: () => boolean;
};

/**
 * Lookup the registered ACP runtime backend by id. Uses the multi-strategy
 * SDK loader so we work whether the plugin was loaded from a globally-
 * installed openclaw, a nemoclaw bundle, or a dev workspace.
 */
export async function resolveBackend(id: string, logger: AnyLogger): Promise<AcpBackend> {
  let mod: unknown;
  try {
    const result = await importSdk(ACP_RUNTIME_SPEC);
    mod = result.module;
  } catch (e) {
    logger.error(`[automode] ${(e as Error).message}`);
    throw new Error(
      `automode: unable to load the OpenClaw ACP SDK. Is openclaw installed globally and visible to this gateway? Root cause: ${(e as Error).message.slice(0, 300)}`,
    );
  }
  const m = mod as { getAcpRuntimeBackend?: (id?: string) => AcpBackend | null };
  if (typeof m.getAcpRuntimeBackend !== "function") {
    throw new Error(
      `automode: ${ACP_RUNTIME_SPEC} loaded but does not export getAcpRuntimeBackend. Check that your OpenClaw version includes the ACP runtime SDK.`,
    );
  }
  const backend = m.getAcpRuntimeBackend(id);
  if (!backend) {
    throw new Error(
      `automode: ACP backend '${id}' is not registered. Configured backends typically come from the bundled 'acpx' extension (loaded at gateway start) or a user plugin such as 'claude-acp'. Try: openclaw plugins list | grep -iE 'acpx|claude-acp'.`,
    );
  }
  return backend;
}

/**
 * Pre-flight check run at plugin boot. Does NOT require a backend to be
 * registered — just verifies that the SDK module can be imported. This lets us
 * fail loud-and-early with a useful message instead of at first /automode.
 */
export async function sdkPreflight(logger: AnyLogger): Promise<{ ok: boolean; resolvedFrom?: string; error?: string }> {
  try {
    const result = await importSdk(ACP_RUNTIME_SPEC);
    const m = result.module as { getAcpRuntimeBackend?: unknown };
    if (typeof m.getAcpRuntimeBackend !== "function") {
      return { ok: false, resolvedFrom: result.resolvedFrom, error: "SDK module missing getAcpRuntimeBackend" };
    }
    logger.info(`[automode] SDK preflight ok (via ${result.strategy}: ${result.resolvedFrom})`);
    return { ok: true, resolvedFrom: result.resolvedFrom };
  } catch (e) {
    logger.warn(`[automode] SDK preflight failed: ${(e as Error).message.slice(0, 500)}`);
    return { ok: false, error: (e as Error).message };
  }
}

export type DispatchContext = {
  taskId: string;
  cwd: string;
  preferredAgent: string;                   // "auto" allowed
  explicitFallbacks: string[];              // config.fallbackAgents
  discoveredAgents: string[];               // config.discoveredAcpxAgents
  defaultHint?: string;                     // config.defaultAgent (original, for final safety net)
  backendId: string;
  env?: Record<string, string>;
  healthProbeEnabled: boolean;
  retryPolicy: RetryPolicy;
  maxFallbacks: number;
  /** Base delay between fallback attempts; doubles per attempt (capped at 10s). */
  backoffMs?: number;
};

export type EnsureResult = {
  backend: AcpBackend;
  handle: AcpHandle;
  agent: string;                            // agent that actually worked
  tried: string[];
  attempts: Array<{ agent: string; error: ErrorClassification }>;
};

export class Dispatcher {
  constructor(private readonly logger: AnyLogger) {}

  async ensure(ctx: DispatchContext): Promise<EnsureResult> {
    const chain = buildAgentChain({
      preferred: ctx.preferredAgent,
      explicitFallbacks: ctx.explicitFallbacks,
      discovered: ctx.discoveredAgents,
      defaultHint: ctx.defaultHint,
      maxLength: ctx.maxFallbacks + 1,
    });
    // If the chain collapsed to just the sentinel "auto" it means no acpx
    // agents were discovered AND no concrete default was provided. Fail fast
    // with a useful remediation message rather than punting to the backend
    // which would just 404.
    const onlyAutoSentinel =
      chain.length === 1 && chain[0] === "auto" && ctx.discoveredAgents.length === 0;
    if (onlyAutoSentinel) {
      throw new Error(
        "automode: no acpx agents available. Configure plugins.entries.acpx.config.agents in your openclaw.json, or set plugins.entries.automode.config.defaultAgent to a concrete agent id.",
      );
    }
    const tried: string[] = [];
    const attempts: Array<{ agent: string; error: ErrorClassification }> = [];
    let backend: AcpBackend | null = null;

    const base = Math.max(0, ctx.backoffMs ?? 0);
    for (let attempt = 0; attempt < chain.length; attempt++) {
      const agent = chain[attempt]!;
      tried.push(agent);
      if (attempt > 0 && base > 0) {
        const delay = Math.min(10_000, base * 2 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        backend = await resolveBackend(ctx.backendId, this.logger);
        const handle = await backend.runtime.ensureSession({
          sessionKey: `automode-${ctx.taskId}`,
          agent,
          mode: "persistent",
          cwd: ctx.cwd,
          env: ctx.env,
        });
        if (ctx.healthProbeEnabled && typeof backend.runtime.getStatus === "function") {
          try {
            await backend.runtime.getStatus({ handle });
          } catch (probeErr) {
            const c = classifyError(probeErr, ctx.retryPolicy);
            attempts.push({ agent, error: c });
            await backend.runtime
              .close({ handle, reason: `automode: health probe failed (${c.kind})` })
              .catch(() => undefined);
            if (c.retryable) {
              this.logger.warn(
                `[automode] agent '${agent}' failed health probe (${c.kind}): ${c.message.slice(0, 200)}`,
              );
              continue;
            }
            throw probeErr;
          }
        }
        if (attempts.length > 0) {
          this.logger.info(
            `[automode] dispatcher settled on agent '${agent}' after ${attempts.length} fallback(s).`,
          );
        }
        return { backend, handle, agent, tried, attempts };
      } catch (e) {
        const c = classifyError(e, ctx.retryPolicy);
        attempts.push({ agent, error: c });
        this.logger.warn(
          `[automode] agent '${agent}' ensure failed (${c.kind}${c.retryable ? ", retrying" : ", fatal"}): ${c.message.slice(0, 200)}`,
        );
        if (!c.retryable) break;
      }
    }
    const summary = attempts
      .map((a) => `${a.agent}=${a.error.kind}`)
      .join(", ");
    throw new Error(
      `automode: all agents failed after ${attempts.length} attempt(s); tried=[${tried.join(", ")}]; ${summary}`,
    );
  }

  async *runTurn(
    backend: AcpBackend,
    handle: AcpHandle,
    text: string,
    requestId: string,
    signal: AbortSignal,
  ): AsyncIterable<AcpRuntimeEventLike> {
    const iter = backend.runtime.runTurn({
      handle,
      text,
      mode: "prompt",
      requestId,
      signal,
    });
    for await (const ev of iter) {
      yield ev as AcpRuntimeEventLike;
    }
  }

  async cancel(backend: AcpBackend, handle: AcpHandle, reason: string): Promise<void> {
    try {
      await backend.runtime.cancel({ handle, reason });
    } catch (e) {
      this.logger.warn(`[automode] cancel failed: ${(e as Error).message}`);
    }
  }

  async close(backend: AcpBackend, handle: AcpHandle, reason: string): Promise<void> {
    try {
      await backend.runtime.close({ handle, reason });
    } catch (e) {
      this.logger.warn(`[automode] close failed: ${(e as Error).message}`);
    }
  }
}

export { DEFAULT_RETRY_POLICY };
