import type { AutomodeConfig, TaskState, VerbosityLevel } from "../types.js";
import { makeThrottler, withTimeout, type Throttler } from "./throttle.js";

const SEND_TIMEOUT_MS = 10_000;
const VERBOSE_RATE_PER_SEC = 2;  // max 2 verbose msgs/sec per task
const VERBOSE_BURST = 6;

type AnyLogger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

type SendResult = { messageId?: number; chatId?: string };

export type TelegramButton = {
  text: string;
  callback_data: string;
  style?: "primary" | "success" | "danger";
};

export type TelegramSendOpts = {
  accountId?: string;
  buttons?: TelegramButton[][];
  replyToMessageId?: number;
};

type MaybeTelegramApi = {
  sendMessageTelegram?: (
    chatId: string,
    text: string,
    opts?: TelegramSendOpts,
  ) => Promise<SendResult>;
  editMessageTelegram?: (
    chatId: string,
    messageId: number,
    text: string,
    opts?: TelegramSendOpts,
  ) => Promise<SendResult>;
};

function resolveTelegramApi(runtime: unknown): MaybeTelegramApi | null {
  const r = runtime as { channel?: { telegram?: MaybeTelegramApi } } | undefined;
  return r?.channel?.telegram ?? null;
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
  constructor(
    private readonly runtime: unknown,
    private readonly cfg: AutomodeConfig,
    private readonly logger: AnyLogger,
  ) {}

  private throttlerFor(taskId: string): Throttler {
    let t = this.verboseThrottlers.get(taskId);
    if (!t) {
      t = makeThrottler(VERBOSE_RATE_PER_SEC, VERBOSE_BURST);
      this.verboseThrottlers.set(taskId, t);
    }
    return t;
  }

  private get api(): MaybeTelegramApi | null {
    return resolveTelegramApi(this.runtime);
  }

  enabled(task?: TaskState): boolean {
    if (!this.cfg.telegram.enabled) return false;
    const chat = normalizeTaskChatId(task?.telegram?.chatId, this.cfg.telegram.chatId);
    return !!chat && !!this.api?.sendMessageTelegram;
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
      `goal: ${task.goal}`,
    ].join("\n");
    try {
      const res = await this.api!.sendMessageTelegram!(ch.chatId, text, {
        accountId: ch.accountId,
      });
      return res.messageId;
    } catch (e) {
      this.logger.warn(`[automode] telegram start notify failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  async notifyProgress(task: TaskState, turn: number, summary: string): Promise<number | undefined> {
    if (!this.enabled(task)) return undefined;
    const ch = this.resolveChat(task);
    if (!ch) return undefined;
    const text = [
      `🔄 automode \`${task.id}\``,
      `turn ${turn} / ${task.caps.maxTurns}`,
      ``,
      summary.slice(0, 1200),
    ].join("\n");
    try {
      if (task.telegram?.progressMessageId && this.api?.editMessageTelegram) {
        await withTimeout(
          this.api.editMessageTelegram(
            ch.chatId,
            task.telegram.progressMessageId,
            text,
            { accountId: ch.accountId },
          ),
          SEND_TIMEOUT_MS,
          "telegram edit",
        );
        return task.telegram.progressMessageId;
      }
      const res = await withTimeout(
        this.api!.sendMessageTelegram!(ch.chatId, text, { accountId: ch.accountId }),
        SEND_TIMEOUT_MS,
        "telegram send",
      );
      return res.messageId;
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
      const res = await this.api!.sendMessageTelegram!(ch.chatId, text, {
        accountId: ch.accountId,
        buttons,
      });
      return res.messageId;
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
      await withTimeout(
        this.api!.sendMessageTelegram!(ch.chatId, text, { accountId: ch.accountId }),
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
      await this.api!.sendMessageTelegram!(ch.chatId, text, {
        accountId: ch.accountId,
      });
    } catch (e) {
      this.logger.warn(`[automode] telegram done notify failed: ${(e as Error).message}`);
    }
  }
}
