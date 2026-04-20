type AnyLogger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export type AutomodeMetrics = {
  incTaskStarted(labels: { autonomy: string; backend: string; dryRun: boolean }): void;
  incTaskEnded(labels: { status: string; autonomy: string }): void;
  incTurn(labels: { agent: string; backend: string }): void;
  incToolCall(labels: { tool: string; allowed: boolean }): void;
  addCost(amountUsd: number, labels: { agent: string; backend: string }): void;
};

const NOOP: AutomodeMetrics = {
  incTaskStarted: () => undefined,
  incTaskEnded: () => undefined,
  incTurn: () => undefined,
  incToolCall: () => undefined,
  addCost: () => undefined,
};

/**
 * Best-effort OTel metrics exporter. Uses `api.runtime.otel` if the host's
 * diagnostics-otel plugin exposes a meter; otherwise falls back to a no-op.
 *
 * The exported instruments:
 *   automode.tasks.started{autonomy,backend,dry_run}
 *   automode.tasks.ended{status,autonomy}
 *   automode.turns.total{agent,backend}
 *   automode.tool_calls.total{tool,allowed}
 *   automode.cost.usd{agent,backend}
 */
export function buildMetrics(runtime: unknown, logger: AnyLogger): AutomodeMetrics {
  try {
    const otel = (runtime as { otel?: { meter?: unknown } } | undefined)?.otel;
    if (!otel?.meter) return NOOP;
    const meter = otel.meter as {
      createCounter: (name: string, opts?: unknown) => { add: (v: number, attrs?: unknown) => void };
    };
    const tasksStarted = meter.createCounter("automode.tasks.started");
    const tasksEnded = meter.createCounter("automode.tasks.ended");
    const turns = meter.createCounter("automode.turns.total");
    const toolCalls = meter.createCounter("automode.tool_calls.total");
    const cost = meter.createCounter("automode.cost.usd");
    logger.info("[automode] OTel metrics exporter enabled");
    return {
      incTaskStarted: (l) => tasksStarted.add(1, { ...l, dry_run: l.dryRun }),
      incTaskEnded: (l) => tasksEnded.add(1, l),
      incTurn: (l) => turns.add(1, l),
      incToolCall: (l) => toolCalls.add(1, l),
      addCost: (amount, l) => {
        if (Number.isFinite(amount) && amount > 0) cost.add(amount, l);
      },
    };
  } catch (e) {
    logger.warn(`[automode] OTel setup failed: ${(e as Error).message}`);
    return NOOP;
  }
}
