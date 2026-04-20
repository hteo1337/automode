import { Dispatcher, type AcpBackend, type AcpHandle } from "./dispatcher.js";
import { mapRoleToAgent } from "./fallback.js";
import { runOneTurn, type TurnOutcome } from "../engine/runner.js";
import { buildDispatchContext } from "../engine/dispatch-ctx.js";
import type { AutomodeConfig, Subtask, TaskState } from "../types.js";

type AnyLogger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export type WorkerResult = {
  subtaskId: string;
  outcome: TurnOutcome;
  handle: AcpHandle;
  backend: AcpBackend;
};

export async function runWorkersOnce(
  dispatcher: Dispatcher,
  task: TaskState,
  subtasks: Subtask[],
  cfg: AutomodeConfig,
  logger: AnyLogger,
  signal: AbortSignal,
  turnIndex: number,
): Promise<WorkerResult[]> {
  const eligible = subtasks.filter(
    (s) => !["done", "failed", "stopped"].includes(s.status),
  );
  const limit = Math.min(cfg.maxParallel, eligible.length);
  const selected = eligible.slice(0, limit);

  const runs = selected.map(async (s) => {
    const resolvedAgent = mapRoleToAgent(
      s.agent,
      cfg.discoveredAcpxAgents,
      cfg.agentRoleMap,
      cfg.defaultAgent,
    );
    const ensureResult = await dispatcher.ensure(
      buildDispatchContext({
        taskId: `${task.id}-${s.id}`,
        cwd: task.cwd,
        preferredAgent: resolvedAgent,
        cfg,
      }),
    );
    const { backend, handle } = ensureResult;
    if (ensureResult.tried.length > 1) {
      logger.info(
        `[automode] worker ${s.id}: settled on ${ensureResult.agent} after trying ${ensureResult.tried.join(", ")}`,
      );
    }
    const subtaskView: TaskState = {
      ...task,
      goal: s.goal,
      progressSummary: task.progressSummary,
      config: { ...task.config, defaultAgent: ensureResult.agent },
    };
    const outcome = await runOneTurn(
      dispatcher,
      backend,
      handle,
      subtaskView,
      cfg,
      turnIndex,
      logger,
      signal,
      undefined,
    );
    return { subtaskId: s.id, outcome, handle, backend } as WorkerResult;
  });

  return Promise.all(runs);
}
