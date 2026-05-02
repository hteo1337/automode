import type { AutomodeConfig, TaskState, VerbosityLevel } from "../types.js";
import { makeThrottler, withTimeout, type Throttler } from "./throttle.js";
import { loadTelegramSdk, type TelegramSdk } from "./sdk.js";

const SEND_TIMEOUT_MS = 10_000;
const VERBOSE_RATE_PER_SEC = 2;  // max 2 verbose msgs/sec per task
const VERBOSE_BURST = 6;

type AnyLogger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export type TelegramButton = {
  text: string;
  callback_data: string;
  style?: "primary" | "success" | "danger";
};

export type TelegramSendOpts = {
  accountId?: string;
  buttons?: TelegramButton[][];
  replyToMessageId?: number;
  textMode?: "markdown" | "html";
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Reject bogus task-local chat ids. `ctx.channel` from OpenClaw's command
 * dispatch is a channel KIND, not a chat id — so old task state may carry
 * `"telegram"`, `"slack"`, or `"discord"` as a faux chatId. Those would route
 * nowhere; fall back to the configured chatId instead.
 *
 * Fix authored by the user; see CHANGELOG 0.3.3.
 */
export function normalizeTaskChatId(
  chatId: string | undefined,
  fallback: string | undefined,
): string | undefined {
  const trimmed = chatId?.trim();
  if (!trimmed) return fallback;
  if (trimmed === "telegram" || trimmed === "slack" || trimmed === "discord") {
    return fallback;
  }
  return trimmed;
}

export class TelegramNotifier {
  private readonly verboseThrottlers = new Map<string, Throttler>();
  private sdkPromise: Promise<TelegramSdk | null> | null = null;

  constructor(
    _runtime: unknown, // kept for backwards-compat with existing call sites
    private readonly cfg: AutomodeConfig,
    private readonly logger: AnyLogger,
    /**
     * Resolved openclaw runtime config (`api.config` from register()).
     * The bundled `sendMessageTelegram` validates this via
     * `requireRuntimeConfig(opts.cfg, ...)`, so without it every Telegram
     * call throws "Telegram API context requires a resolved runtime config".
     * Optional for backwards-compat with older callers.
     */
    private readonly runtimeConfig?: unknown,
  ) {}

  private throttlerFor(taskId: string): Throttler {
    let t = this.verboseThrottlers.get(taskId);
    if (!t) {
      t = makeThrottler(VERBOSE_RATE_PER_SEC, VERBOSE_BURST);
      this.verboseThrottlers.set(taskId, t);
    }
    return t;
  }

  /** Lazy-load the telegram SDK once and reuse. */
  private sdk(): Promise<TelegramSdk | null> {
    if (!this.sdkPromise) this.sdkPromise = loadTelegramSdk(this.logger, this.runtimeConfig);
    return this.sdkPromise;
  }

  enabled(task?: TaskState): boolean {
    if (!this.cfg.telegram.enabled) return false;
    const chat = normalizeTaskChatId(task?.telegram?.chatId, this.cfg.telegram.chatId);
    return !!chat;
  }

  private resolveChat(task: TaskState): { chatId: string; accountId: string } | null {
    const chatId = normalizeTaskChatId(task.telegram?.chatId, this.cfg.telegram.chatId);
    const accountId =
      task.telegram?.accountId ?? this.cfg.telegram.accountId ?? "default";
    if (!chatId) return null;
    return { chatId, accountId };
  }

  async notifyStart(task: TaskState): Promise<number | undefined> {
    if (!this.enabled(task)) return undefined;
    const ch = this.resolveChat(task);
    if (!ch) return undefined;
    const superYoloWarning =
      task.config.autonomy === "super-yolo"
        ? "🚨 SUPER-YOLO MODE: all tool guards disabled"
        : null;
    const text = [
      `🤖 automode task started`,
      `id: \`${task.id}\``,
      `mode: ${task.mode}   autonomy: ${task.config.autonomy}`,
      `agent: ${task.config.defaultAgent} (${task.config.backend})`,
      ...(superYoloWarning ? [``, superYoloWarning] : []),
      ``,
      // Cap goal to keep us safely below Telegram's 4096-char message limit
      // even after counting markdown overhead — long /automode prompts
      // (1k+ chars) otherwise trigger 400 "message is too long".
      `goal: ${task.goal.length > 1500 ? `${task.goal.slice(0, 1500)} …(+${task.goal.length - 1500} chars)` : task.goal}`,
    ].join("\n");
    try {
      const sdk = await this.sdk();
      if (!sdk) return undefined;
      const res = await withTimeout(
        sdk.sendMessage(ch.chatId, text, { accountId: ch.accountId }),
        SEND_TIMEOUT_MS,
        "telegram send",
      );
      return typeof res?.messageId === "string" ? Number(res.messageId) : undefined;
    } catch (e) {
      this.logger.warn(`[automode] telegram start notify failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  async notifyProgress(task: TaskState, turn: number, summary: string): Promise<number | undefined> {
    if (!this.enabled(task)) return undefined;
    const ch = this.resolveChat(task);
    if (!ch) return undefined;

    // 0.4.0: rich progress dashboard with ETA.
    const started = task.startedAt ?? Date.now();
    const elapsedMs = Date.now() - started;
    const avgTurnMs = turn > 0 ? elapsedMs / turn : 0;
    const turnsLeft = Math.max(0, task.caps.maxTurns - turn);
    const etaMs = Math.min(
      avgTurnMs * turnsLeft,
      Math.max(0, task.caps.maxDurationSec * 1000 - elapsedMs),
    );
    const costLine =
      typeof task.totalCostUsd === "number"
        ? `$${task.totalCostUsd.toFixed(4)}`
        : "(n/a)";
    const tailing = !!task.telegram?.tailActive;
    const text = [
      `${tailing ? "📡" : "🔄"} automode \`${task.id}\` · turn ${turn}/${task.caps.maxTurns}`,
      `${task.config.defaultAgent} @ ${task.config.backend} · cost ${costLine} · elapsed ${formatDuration(elapsedMs)} · ETA ~${formatDuration(etaMs)}`,
      ``,
      summary.slice(0, 1200),
    ].join("\n");
    const buttons: TelegramButton[][] | undefined = tailing
      ? [
          [
            { text: "🛑  Stop tailing", callback_data: `automode:menu:untail:${task.id}`, style: "danger" },
            { text: "🔍  Details", callback_data: `automode:menu:nav:task:${task.id}` },
          ],
        ]
      : undefined;
    try {
      const sdk = await this.sdk();
      if (!sdk) return undefined;
      if (task.telegram?.progressMessageId) {
        try {
          await withTimeout(
            sdk.editMessage(ch.chatId, task.telegram.progressMessageId, text, {
              accountId: ch.accountId,
              buttons,
            }),
            SEND_TIMEOUT_MS,
            "telegram edit",
          );
          return task.telegram.progressMessageId;
        } catch {
          // Fall through to a fresh send if the edit fails (message gone, etc.)
        }
      }
      const res = await withTimeout(
        sdk.sendMessage(ch.chatId, text, { accountId: ch.accountId, buttons }),
        SEND_TIMEOUT_MS,
        "telegram send",
      );
      return typeof res?.messageId === "string" ? Number(res.messageId) : undefined;
    } catch (e) {
      this.logger.warn(`[automode] telegram progress notify failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  async notifyEscalation(
    task: TaskState,
    reason: string,
    buttons?: TelegramButton[][],
  ): Promise<number | undefined> {
    if (!this.enabled(task)) return undefined;
    const ch = this.resolveChat(task);
    if (!ch) return undefined;
    const text = [`⚠️ automode needs approval`, `task: \`${task.id}\``, ``, reason].join("\n");
    try {
      const sdk = await this.sdk();
      if (!sdk) return undefined;
      const res = await withTimeout(
        sdk.sendMessage(ch.chatId, text, { accountId: ch.accountId, buttons }),
        SEND_TIMEOUT_MS,
        "telegram escalation send",
      );
      return typeof res?.messageId === "string" ? Number(res.messageId) : undefined;
    } catch (e) {
      this.logger.warn(`[automode] telegram escalation notify failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Push an extra, human-readable line for this turn when the task's verbosity
   * level is high enough. Level gating (what to show at each level):
   *   1 = one-line turn summary, emitted on turn end
   *   2 = turn start + each tool call name + turn end
   *   3 = all of the above plus first-100-chars of agent output and thoughts
   */
  async notifyVerbose(
    task: TaskState,
    atLeast: VerbosityLevel,
    line: string,
  ): Promise<void> {
    const level = task.config.verbosity ?? this.cfg.verbosity ?? 0;
    if (level < atLeast) return;
    if (!this.enabled(task)) return;
    const ch = this.resolveChat(task);
    if (!ch) return;
    // Rate-limit verbose emission per task to avoid Telegram flooding during
    // long tool-heavy turns.
    const throttler = this.throttlerFor(task.id);
    if (!throttler.allow()) return;
    const dropped = throttler.droppedSinceLast();
    const prefix = dropped > 0 ? `(+${dropped} dropped) ` : "";
    const text = `· \`${task.id}\` ${prefix}${line}`.slice(0, 3500);
    try {
      const sdk = await this.sdk();
      if (!sdk) return;
      await withTimeout(
        sdk.sendMessage(ch.chatId, text, { accountId: ch.accountId }),
        SEND_TIMEOUT_MS,
        "telegram verbose send",
      );
    } catch (e) {
      this.logger.warn(`[automode] verbose notify failed: ${(e as Error).message}`);
    }
  }

  /** Flush the throttler state for a task when it completes. */
  disposeTask(taskId: string): void {
    this.verboseThrottlers.delete(taskId);
  }

  async notifyDone(task: TaskState, verdict: string, summary: string): Promise<void> {
    if (!this.enabled(task)) return;
    const ch = this.resolveChat(task);
    if (!ch) return;
    const costLine =
      typeof task.totalCostUsd === "number"
        ? `cost: $${task.totalCostUsd.toFixed(4)}`
        : null;
    const text = [
      `✅ automode finished`,
      `id: \`${task.id}\``,
      `status: ${verdict}`,
      `turns: ${task.turnCount}`,
      ...(costLine ? [costLine] : []),
      ``,
      summary.slice(0, 1500),
    ].join("\n");
    try {
      const sdk = await this.sdk();
      if (!sdk) return;
      await withTimeout(
        sdk.sendMessage(ch.chatId, text, { accountId: ch.accountId }),
        SEND_TIMEOUT_MS,
        "telegram done send",
      );
    } catch (e) {
      this.logger.warn(`[automode] telegram done notify failed: ${(e as Error).message}`);
    }
  }

  /** Exposed for the menu sender which lives in index.ts. */
  async getSdk(): Promise<TelegramSdk | null> {
    return this.sdk();
  }
}
