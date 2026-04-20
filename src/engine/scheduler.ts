import { Dispatcher } from "../agents/dispatcher.js";
import { TaskStore } from "./state.js";
import { runOneTurn, updateProgressSummary } from "./runner.js";
import { decide as supervisorDecide } from "./supervisor.js";
import { plan as runPlanner, fallback as plannerFallback } from "./planner.js";
import { installTaskSafety } from "../safety/wrapper.js";
import { runWorkersOnce } from "../agents/pool.js";
import { MultiChannelNotifier } from "../notifiers/multi.js";
import type { AutomodeMetrics } from "../observability/otel.js";
import { buildDispatchContext } from "./dispatch-ctx.js";
import { policyFor } from "./autonomy.js";
import type {
  AutomodeConfig,
  Escalation,
  StartOptions,
  TaskMode,
  TaskState,
  TurnRecord,
} from "../types.js";

type AnyLogger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

type ActiveRun = {
  abortController: AbortController;
  stopRequested: boolean;
  runningPromise: Promise<void>;
};

export class Scheduler {
  private readonly active = new Map<string, ActiveRun>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly cfg: AutomodeConfig,
    private readonly store: TaskStore,
    private readonly dispatcher: Dispatcher,
    private readonly notifier: MultiChannelNotifier,
    private readonly logger: AnyLogger,
    private readonly metrics?: AutomodeMetrics,
    private readonly onTaskDone?: (task: TaskState) => void | Promise<void>,
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick().catch((e) => {
      this.logger.warn(`[automode] tick failed: ${(e as Error).message}`);
    }), this.cfg.schedulerTickMs);
    // Resume any tasks that were running when the gateway stopped.
    for (const t of this.store.listRunning()) {
      if (t.status === "paused" || t.status === "escalating") continue;
      this.launch(t).catch((e) =>
        this.logger.error(`[automode] resume failed for ${t.id}: ${(e as Error).message}`),
      );
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const promises: Promise<void>[] = [];
    for (const [id, run] of this.active) {
      run.stopRequested = true;
      run.abortController.abort();
      promises.push(run.runningPromise.catch(() => undefined));
      this.logger.info(`[automode] stopping task ${id} on shutdown`);
    }
    await Promise.all(promises);
  }

  async startTask(opts: StartOptions): Promise<TaskState> {
    const id = newId();
    const mode: TaskMode = opts.mode ?? "hybrid";
    const now = Date.now();
    const state: TaskState = {
      id,
      version: 1,
      goal: opts.goal.trim(),
      owner: opts.owner,
      mode,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      dryRun: Boolean(opts.dryRun),
      onDone: opts.onDone,
      onFail: opts.onFail,
      templateName: opts.templateName,
      cwd: opts.cwd ?? process.cwd(),
      scope: { paths: opts.scopePaths ?? [] },
      caps: {
        maxTurns: opts.maxTurns ?? this.cfg.maxTurns,
        maxDurationSec: opts.maxDurationSec ?? this.cfg.maxDurationSec,
      },
      config: {
        defaultAgent: opts.agent ?? this.cfg.defaultAgent,
        backend: opts.backend ?? this.cfg.backend,
        allowedTools: this.cfg.allowedTools,
        deniedBashPatterns: this.cfg.deniedBashPatterns,
        parallelismPolicy: this.cfg.parallelismPolicy,
        maxParallel: this.cfg.maxParallel,
        planFirstThreshold: this.cfg.planFirstThreshold,
        verbosity: opts.verbosity ?? this.cfg.verbosity,
        autonomy: opts.autonomy ?? this.cfg.autonomy,
      },
      interval:
        mode === "interval" && opts.intervalSec
          ? { everySec: opts.intervalSec }
          : undefined,
      nextFireAt: mode === "interval" && opts.intervalSec ? now + opts.intervalSec * 1000 : undefined,
      planFirst: Boolean(opts.planFirst),
      progressSummary: "",
      turnCount: 0,
      escalations: [],
      telegram: {
        chatId: opts.chatId ?? this.cfg.telegram.chatId,
        accountId: this.cfg.telegram.accountId,
      },
    };
    const paths = this.store.paths(id);
    this.store.save(state);
    try {
      installTaskSafety(this.cfg, state, paths);
      if (state.config.autonomy === "super-yolo") {
        this.logger.warn(
          `[automode] 🚨 task ${id} starting in SUPER-YOLO mode: all tool guards disabled (allowlist, denylist, path-scope all bypassed).`,
        );
      }
    } catch (e) {
      this.logger.warn(`[automode] failed to install safety layer for ${id}: ${(e as Error).message}`);
    }
    const startMsg = await this.notifier.notifyStart(state);
    if (startMsg) {
      state.telegram!.startMessageId = startMsg;
      state.telegram!.progressMessageId = startMsg;
      this.store.save(state);
    }
    this.metrics?.incTaskStarted({
      autonomy: state.config.autonomy,
      backend: state.config.backend,
      dryRun: Boolean(state.dryRun),
    });
    this.launch(state).catch((e) =>
      this.logger.error(`[automode] launch failed for ${id}: ${(e as Error).message}`),
    );
    return state;
  }

  listRunning(): TaskState[] {
    return this.store.listRunning();
  }

  list(): TaskState[] {
    return this.store.listAll();
  }

  get(id: string): TaskState | null {
    return this.store.load(id);
  }

  /**
   * When `strictOwner` is on, mutating operations (stop/pause/resume) are
   * rejected unless the caller is the task's owner. `requesterId` is
   * `ctx.senderId` from the command context. Returns null = allowed, or an
   * error message string when denied.
   */
  private checkOwner(state: TaskState, requesterId: string | undefined): string | null {
    if (!this.cfg.strictOwner) return null;
    const owner = state.owner?.senderId;
    if (!owner) return null; // orphan tasks (e.g. from config) are open
    if (!requesterId) return `task ${state.id} is owned by ${owner}; caller identity unknown`;
    if (owner !== requesterId) return `task ${state.id} is owned by ${owner}, not ${requesterId}`;
    return null;
  }

  async stopTask(id: string, reason = "user", requesterId?: string): Promise<{ ok: boolean; error?: string }> {
    const state = this.store.load(id);
    if (!state) return { ok: false, error: `no task ${id}` };
    const denied = this.checkOwner(state, requesterId);
    if (denied) return { ok: false, error: denied };
    const run = this.active.get(id);
    if (run) {
      run.stopRequested = true;
      run.abortController.abort();
      await run.runningPromise.catch(() => undefined);
    }
    state.status = "stopped";
    state.stopReason = reason;
    state.endedAt = Date.now();
    this.store.save(state);
    await this.notifier.notifyDone(state, "stopped", `Stopped: ${reason}`);
    return { ok: true };
  }

  async pauseTask(id: string, requesterId?: string): Promise<{ ok: boolean; error?: string }> {
    const state = this.store.load(id);
    if (!state) return { ok: false, error: `no task ${id}` };
    const denied = this.checkOwner(state, requesterId);
    if (denied) return { ok: false, error: denied };
    const run = this.active.get(id);
    if (run) {
      run.stopRequested = true;
      run.abortController.abort();
      await run.runningPromise.catch(() => undefined);
    }
    state.status = "paused";
    this.store.save(state);
    return { ok: true };
  }

  async resumeTask(id: string, requesterId?: string): Promise<{ ok: boolean; error?: string }> {
    const state = this.store.load(id);
    if (!state) return { ok: false, error: `no task ${id}` };
    const denied = this.checkOwner(state, requesterId);
    if (denied) return { ok: false, error: denied };
    if (state.status !== "paused" && state.status !== "escalating") {
      return { ok: false, error: `task ${id} is ${state.status}, cannot resume` };
    }
    state.status = "running";
    this.store.save(state);
    await this.launch(state);
    return { ok: true };
  }

  async resolveEscalation(
    taskId: string,
    escalationId: string,
    decision: "approve" | "deny" | "modify" | "stop",
    note?: string,
  ): Promise<boolean> {
    const state = this.store.load(taskId);
    if (!state) return false;
    const esc = state.escalations.find((e) => e.id === escalationId);
    if (!esc) return false;
    esc.resolvedAt = Date.now();
    esc.decision = decision;
    esc.note = note;
    if (decision === "stop" || decision === "deny") {
      state.status = "stopped";
      state.stopReason = `escalation ${decision}`;
      state.endedAt = Date.now();
      this.store.save(state);
      await this.notifier.notifyDone(state, "stopped", `Escalation ${decision}: ${esc.reason}`);
      return true;
    }
    state.status = "running";
    this.store.save(state);
    await this.launch(state);
    return true;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    for (const t of this.store.listAll()) {
      if (t.status === "escalating" && t.updatedAt + this.cfg.escalationTimeoutSec * 1000 < now) {
        t.status = "paused";
        this.store.save(t);
        continue;
      }
      if (t.status === "waiting" && t.nextFireAt && t.nextFireAt <= now) {
        if (!this.active.has(t.id)) {
          t.status = "running";
          this.store.save(t);
          this.launch(t).catch((e) =>
            this.logger.warn(`[automode] relaunch ${t.id} failed: ${(e as Error).message}`),
          );
        }
      }
    }
  }

  private async launch(state: TaskState): Promise<void> {
    if (this.active.has(state.id)) return;
    const abortController = new AbortController();
    const run: ActiveRun = {
      abortController,
      stopRequested: false,
      runningPromise: Promise.resolve(),
    };
    this.active.set(state.id, run);
    run.runningPromise = this.loop(state, run).finally(() => {
      this.active.delete(state.id);
    });
  }

  private async loop(state: TaskState, run: ActiveRun): Promise<void> {
    try {
      if (!state.startedAt) state.startedAt = Date.now();
      state.status = "running";
      this.store.save(state);

      // Dry-run short-circuit: never dispatch anything, record a synthetic
      // turn, mark done. Must come BEFORE the planner phase so we don't
      // spend tokens planning a pretend task.
      if (state.dryRun) {
        const fakeRec: TurnRecord = {
          index: 1,
          startedAt: Date.now(),
          endedAt: Date.now(),
          backend: state.config.backend,
          agent: state.config.defaultAgent,
          requestId: `dry-${state.id}-1`,
          prompt: `[dry-run] agent=${state.config.defaultAgent}, backend=${state.config.backend}, autonomy=${state.config.autonomy}, goal=${state.goal.slice(0, 200)}`,
          events: [],
          toolCalls: [],
          stopReason: "dry-run",
        };
        state.turnCount = 1;
        this.store.appendTurn(state.id, fakeRec);
        this.store.save(state);
        await this.finish(state, "done", "dry-run: no planner, no dispatch, no tool calls");
        return;
      }

      // Phase: planning (only once, or when plan is missing)
      if (!state.planner) {
        state.status = "planning";
        this.store.save(state);
        const plannerEnsure = await this.dispatcher.ensure(
          buildDispatchContext({
            taskId: `${state.id}-planner`,
            cwd: state.cwd,
            preferredAgent: state.config.defaultAgent,
            cfg: this.cfg,
          }),
        );
        if (plannerEnsure.tried.length > 1) {
          this.logger.info(
            `[automode] planner: settled on ${plannerEnsure.agent} after trying ${plannerEnsure.tried.join(", ")}`,
          );
        }
        const { backend, handle } = plannerEnsure;
        try {
          state.planner = await runPlanner(
            this.dispatcher,
            backend,
            handle,
            state,
            this.logger,
            run.abortController.signal,
          );
        } catch (e) {
          state.planner = plannerFallback(state, 0.3, `planner failed: ${(e as Error).message}`);
        }
        const policy = policyFor(state.config.autonomy);
        const belowThreshold =
          state.planner.confidence < state.config.planFirstThreshold;
        const parallelAskMode = state.config.parallelismPolicy === "ask";
        const shouldPauseForPlan =
          // `plan` subcommand always pauses regardless of autonomy
          (state.planFirst && !policy.autoApprovePlan) ||
          // low confidence pauses unless autonomy auto-approves
          (belowThreshold && !policy.autoApproveLowConfidence) ||
          // parallelismPolicy="ask" honours the explicit ask intent
          parallelAskMode;
        if (shouldPauseForPlan) {
          state.planFirst = true;
          const esc = this.raiseEscalation(
            state,
            `Plan needs approval (confidence ${state.planner.confidence.toFixed(2)}):\n` +
              state.planner.rationale +
              `\nSubtasks: ${state.planner.subtasks.map((s) => `${s.id}=${s.agent}`).join(", ")}`,
            "info",
          );
          await this.notifier.notifyEscalation(state, esc.reason, [
            [
              { text: "Approve", callback_data: `automode:${state.id}:${esc.id}:approve`, style: "success" },
              { text: "Deny", callback_data: `automode:${state.id}:${esc.id}:deny`, style: "danger" },
            ],
          ]);
          this.store.save(state);
          return;
        }
        if (belowThreshold && policy.autoApproveLowConfidence) {
          this.logger.info(
            `[automode] task ${state.id}: planner confidence ${state.planner.confidence.toFixed(2)} below threshold ${state.config.planFirstThreshold}, but autonomy='${state.config.autonomy}' auto-approved.`,
          );
        }
        this.store.save(state);
      }

      state.status = "running";
      this.store.save(state);

      // Execution loop
      while (!run.stopRequested) {
        if (run.abortController.signal.aborted) break;
        // Yield to the event loop every turn so long tasks don't starve the
        // rest of the gateway.
        await new Promise((r) => setImmediate(r));
        if (state.turnCount > 0 && state.turnCount % 10 === 0) {
          this.logger.info(
            `[automode] ${state.id} heartbeat: turn ${state.turnCount}, cost $${(state.totalCostUsd ?? 0).toFixed(4)}`,
          );
        }

        if (state.turnCount >= state.caps.maxTurns) {
          await this.finish(state, "capped", `Reached max turns (${state.caps.maxTurns}).`);
          return;
        }
        const elapsed = (Date.now() - (state.startedAt ?? Date.now())) / 1000;
        if (elapsed >= state.caps.maxDurationSec) {
          await this.finish(state, "capped", `Reached max duration (${state.caps.maxDurationSec}s).`);
          return;
        }

        const turnIndex = state.turnCount + 1;

        // Decide single vs parallel execution based on planner
        if (state.planner?.parallel && state.planner.subtasks.length > 1) {
          state.subtasks = (state.subtasks ?? state.planner.subtasks.map((s) => ({
            id: s.id,
            agent: s.agent,
            goal: s.goal,
            dependsOn: s.dependsOn ?? [],
            status: "running" as const,
            turns: [],
          })));
          const results = await runWorkersOnce(
            this.dispatcher,
            state,
            state.subtasks,
            this.cfg,
            this.logger,
            run.abortController.signal,
            turnIndex,
          );
          let anyComplete = false;
          let escalated: { reason: string; severity: "info" | "warn" | "block" } | undefined;
          let collectedDenied: Array<{ name: string; reason: string }> = [];
          for (const r of results) {
            state.progressSummary = updateProgressSummary(state.progressSummary, r.outcome);
            this.store.appendTurn(state.id, r.outcome.record);
            const sub = state.subtasks.find((s) => s.id === r.subtaskId);
            if (sub) sub.turns.push(r.outcome.record);
            if (r.outcome.completeCalled) {
              if (sub) sub.status = "done";
              anyComplete = true;
            }
            if (r.outcome.escalateCalled) escalated = r.outcome.escalateCalled;
            collectedDenied = collectedDenied.concat(r.outcome.deniedToolCalls);
          }
          state.turnCount = turnIndex;
          this.store.save(state);
          await this.notifier.notifyProgress(state, turnIndex, state.progressSummary);

          // Coordinator decision
          const allDone = state.subtasks.every((s) => s.status === "done");
          if (allDone) {
            await this.finish(state, "done", `All ${state.subtasks.length} workers completed.`);
            return;
          }
          if (escalated) {
            const esc = this.raiseEscalation(state, escalated.reason, escalated.severity);
            await this.notifier.notifyEscalation(state, esc.reason, [
              [
                { text: "Approve", callback_data: `automode:${state.id}:${esc.id}:approve`, style: "success" },
                { text: "Deny", callback_data: `automode:${state.id}:${esc.id}:deny`, style: "danger" },
                { text: "Stop", callback_data: `automode:${state.id}:${esc.id}:stop`, style: "danger" },
              ],
            ]);
            this.store.save(state);
            return;
          }
          if (collectedDenied.length > 0) {
            const first = collectedDenied[0]!;
            const esc = this.raiseEscalation(state, `Denied tool '${first.name}': ${first.reason}`, "block");
            await this.notifier.notifyEscalation(state, esc.reason);
            this.store.save(state);
            return;
          }
          if (anyComplete) {
            // One worker completed but not all — continue.
            continue;
          }
          continue;
        }

        // Single-agent turn
        const ensureResult = await this.dispatcher.ensure(
          buildDispatchContext({
            taskId: state.id,
            cwd: state.cwd,
            preferredAgent: state.config.defaultAgent,
            cfg: this.cfg,
          }),
        );
        if (ensureResult.tried.length > 1) {
          this.logger.info(
            `[automode] turn: settled on ${ensureResult.agent} after trying ${ensureResult.tried.join(", ")}`,
          );
        }
        const { backend, handle } = ensureResult;
        // Remember the agent that actually served this turn (for audit / resume).
        const activeAgent = ensureResult.agent;
        const stateForRun: TaskState = {
          ...state,
          config: { ...state.config, defaultAgent: activeAgent },
        };
        const outcome = await runOneTurn(
          this.dispatcher,
          backend,
          handle,
          stateForRun,
          this.cfg,
          turnIndex,
          this.logger,
          run.abortController.signal,
          this.notifier,
        );
        state.progressSummary = updateProgressSummary(state.progressSummary, outcome);
        state.turnCount = turnIndex;
        this.store.appendTurn(state.id, outcome.record);
        this.metrics?.incTurn({ agent: activeAgent, backend: backend.id });

        // Capture cumulative cost snapshot when the backend exposes it.
        if (typeof backend.runtime.getStatus === "function") {
          try {
            const status = await backend.runtime.getStatus({ handle });
            const cost = (status as { details?: { cost?: unknown } })?.details?.cost;
            if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
              state.totalCostUsd = cost;
            }
          } catch {
            // getStatus is best-effort — ignore failures.
          }
        }

        const decision = supervisorDecide({
          task: state,
          turn: outcome.record,
          completeCalled: outcome.completeCalled,
          escalateCalled: outcome.escalateCalled,
          rescheduleCalled: outcome.rescheduleCalled,
          stopRequested: run.stopRequested,
          deniedToolCalls: outcome.deniedToolCalls,
          maxCostUsd: this.cfg.maxCostUsd,
        });

        this.store.save(state);
        await this.notifier.notifyProgress(state, turnIndex, state.progressSummary);

        switch (decision.kind) {
          case "done":
            await this.finish(state, "done", decision.summary);
            return;
          case "capped": {
            const detail =
              decision.reason === "cost"
                ? `cost cap ($${(state.totalCostUsd ?? 0).toFixed(4)} ≥ $${this.cfg.maxCostUsd.toFixed(4)})`
                : decision.reason;
            await this.finish(state, "capped", `Capped: ${detail}`);
            return;
          }
          case "failed":
            await this.finish(state, "failed", decision.error);
            return;
          case "stopped":
            await this.finish(state, "stopped", "User stop");
            return;
          case "escalate": {
            const esc = this.raiseEscalation(state, decision.reason, decision.severity);
            await this.notifier.notifyEscalation(state, esc.reason, [
              [
                { text: "Approve", callback_data: `automode:${state.id}:${esc.id}:approve`, style: "success" },
                { text: "Deny", callback_data: `automode:${state.id}:${esc.id}:deny`, style: "danger" },
                { text: "Stop", callback_data: `automode:${state.id}:${esc.id}:stop`, style: "danger" },
              ],
            ]);
            this.store.save(state);
            return;
          }
          case "reschedule":
            state.status = "waiting";
            state.nextFireAt = Date.now() + decision.delaySec * 1000;
            this.store.save(state);
            return;
          case "continue":
          default:
            if (state.mode === "interval" && state.interval) {
              state.status = "waiting";
              state.nextFireAt = Date.now() + state.interval.everySec * 1000;
              this.store.save(state);
              return;
            }
            continue;
        }
      }
    } catch (e) {
      this.logger.error(`[automode] loop crashed for ${state.id}: ${(e as Error).message}`);
      await this.finish(state, "failed", (e as Error).message);
    }
  }

  private raiseEscalation(
    state: TaskState,
    reason: string,
    severity: "info" | "warn" | "block",
  ): Escalation {
    const esc: Escalation = {
      id: `e${Date.now().toString(36)}`,
      taskId: state.id,
      reason,
      severity,
      raisedAt: Date.now(),
    };
    state.escalations.push(esc);
    state.status = "escalating";
    this.store.saveEscalation(state.id, esc);
    this.store.save(state);
    return esc;
  }

  private async finish(
    state: TaskState,
    verdict: "done" | "capped" | "failed" | "stopped",
    summary: string,
  ): Promise<void> {
    state.status = verdict;
    state.endedAt = Date.now();
    state.outcomeSummary = summary;
    if (verdict === "failed") state.error = summary;
    this.store.save(state);
    this.metrics?.incTaskEnded({ status: verdict, autonomy: state.config.autonomy });
    // Release per-task throttler state held by the notifier.
    try {
      (this.notifier as unknown as { disposeTask?: (id: string) => void }).disposeTask?.(state.id);
    } catch {
      // ignore
    }
    if (typeof state.totalCostUsd === "number") {
      this.metrics?.addCost(state.totalCostUsd, {
        agent: state.config.defaultAgent,
        backend: state.config.backend,
      });
    }
    await this.notifier.notifyDone(state, verdict, summary);
    if (this.onTaskDone) {
      try {
        await this.onTaskDone(state);
      } catch (e) {
        this.logger.warn(`[automode] onTaskDone handler failed: ${(e as Error).message}`);
      }
    }
  }

  observeToolCall(event: {
    taskId?: string;
    tool: string;
    command?: string;
    blockedBy?: string;
  }): void {
    // Layer 2 (0.2.x+): logged/observed via api.on("before_tool_call").
    // 0.3.0 — if Layer 1 didn't catch a denied call but our policy would, we
    // abort the in-flight turn through the dispatcher's abort controllers.
    if (!event.taskId) return;
    const state = this.store.load(event.taskId);
    if (!state) return;
    if (event.blockedBy && state.config.autonomy !== "super-yolo") {
      const run = this.active.get(event.taskId);
      if (run) {
        this.logger.warn(
          `[automode] Layer 2 cancel: task ${state.id} tool '${event.tool}' — ${event.blockedBy}`,
        );
        run.abortController.abort();
      }
    }
    this.metrics?.incToolCall({ tool: event.tool, allowed: !event.blockedBy });
    const record: TurnRecord = {
      index: -1,
      startedAt: Date.now(),
      endedAt: Date.now(),
      backend: state.config.backend,
      agent: state.config.defaultAgent,
      requestId: "observe",
      prompt: "",
      events: [{ type: "observe", tool: event.tool, command: event.command, blockedBy: event.blockedBy }],
      toolCalls: [
        {
          name: event.tool,
          args: event.command,
          allowed: !event.blockedBy,
          reason: event.blockedBy,
        },
      ],
    };
    this.store.appendTurn(state.id, record);
  }
}

function newId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `t${ts}-${rnd}`;
}
