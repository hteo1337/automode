import type { AutomodeConfig, TaskState, VerbosityLevel } from "../types.js";
import { TelegramNotifier, type TelegramButton } from "../telegram/notifier.js";
import type { TelegramSdk } from "../telegram/sdk.js";

type AnyLogger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

type OutboundSlack = {
  sendTextSlack?: (
    channel: string,
    text: string,
    opts?: { accountId?: string },
  ) => Promise<{ messageId?: number } | undefined>;
};
type OutboundDiscord = {
  sendTextDiscord?: (
    channel: string,
    text: string,
    opts?: { accountId?: string },
  ) => Promise<{ messageId?: number } | undefined>;
};

type RuntimeChannels = {
  telegram?: unknown;
  slack?: OutboundSlack;
  discord?: OutboundDiscord;
};

/**
 * Broadcasts task lifecycle events to every enabled channel. Telegram is the
 * primary; Slack and Discord are best-effort if the respective plugins are
 * installed and expose a `sendText*` helper on `api.runtime.channel.<x>`.
 */
export class MultiChannelNotifier {
  private readonly telegram: TelegramNotifier;

  constructor(
    private readonly runtime: unknown,
    private readonly cfg: AutomodeConfig,
    private readonly logger: AnyLogger,
  ) {
    this.telegram = new TelegramNotifier(runtime, cfg, logger);
  }

  private sidekicks(): Array<(text: string) => Promise<void>> {
    const out: Array<(text: string) => Promise<void>> = [];
    const chans = (this.runtime as { channel?: RuntimeChannels } | undefined)?.channel;
    const slackFn = chans?.slack?.sendTextSlack;
    const slackTarget = this.cfg.notifiers?.slack;
    if (slackFn && slackTarget?.enabled && slackTarget.channel) {
      out.push(async (text) => {
        try {
          await slackFn(slackTarget.channel!, text, { accountId: slackTarget.accountId });
        } catch (e) {
          this.logger.warn(`[automode] slack notify failed: ${(e as Error).message}`);
        }
      });
    }
    const discordFn = chans?.discord?.sendTextDiscord;
    const discordTarget = this.cfg.notifiers?.discord;
    if (discordFn && discordTarget?.enabled && discordTarget.channel) {
      out.push(async (text) => {
        try {
          await discordFn(discordTarget.channel!, text, { accountId: discordTarget.accountId });
        } catch (e) {
          this.logger.warn(`[automode] discord notify failed: ${(e as Error).message}`);
        }
      });
    }
    return out;
  }

  async notifyStart(task: TaskState): Promise<number | undefined> {
    const msgId = await this.telegram.notifyStart(task);
    const text = `🤖 automode task \`${task.id}\` started — ${task.mode}/${task.config.autonomy} — ${task.goal.slice(0, 120)}`;
    for (const send of this.sidekicks()) await send(text);
    return msgId;
  }

  async notifyProgress(task: TaskState, turn: number, summary: string): Promise<number | undefined> {
    return this.telegram.notifyProgress(task, turn, summary);
  }

  async notifyVerbose(task: TaskState, atLeast: VerbosityLevel, line: string): Promise<void> {
    await this.telegram.notifyVerbose(task, atLeast, line);
  }

  async notifyEscalation(
    task: TaskState,
    reason: string,
    buttons?: TelegramButton[][],
  ): Promise<number | undefined> {
    const msgId = await this.telegram.notifyEscalation(task, reason, buttons);
    const text = `⚠️ automode \`${task.id}\` needs approval: ${reason.slice(0, 300)}`;
    for (const send of this.sidekicks()) await send(text);
    return msgId;
  }

  async notifyDone(task: TaskState, verdict: string, summary: string): Promise<void> {
    await this.telegram.notifyDone(task, verdict, summary);
    const costLine =
      typeof task.totalCostUsd === "number" ? ` — cost $${task.totalCostUsd.toFixed(4)}` : "";
    const text = `✅ automode \`${task.id}\` ${verdict}${costLine} — ${summary.slice(0, 300)}`;
    for (const send of this.sidekicks()) await send(text);
  }

  disposeTask(taskId: string): void {
    this.telegram.disposeTask(taskId);
  }

  getSdk(): Promise<TelegramSdk | null> {
    return this.telegram.getSdk();
  }
}
