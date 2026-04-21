import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findOpenclawRoots } from "../agents/sdk-loader.js";

type Logger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

export type TelegramSendOpts = {
  accountId?: string;
  textMode?: "markdown" | "html";
  silent?: boolean;
  replyToMessageId?: number;
  buttons?: Array<Array<{ text: string; callback_data?: string; style?: "primary" | "success" | "danger" }>>;
};

export type TelegramSendResult = {
  messageId: string;
  chatId: string;
};

export type TelegramSdk = {
  sendMessage: (to: string, text: string, opts?: TelegramSendOpts) => Promise<TelegramSendResult>;
  editMessage: (
    chatId: string | number,
    messageId: string | number,
    text: string,
    opts?: TelegramSendOpts,
  ) => Promise<unknown>;
  editReplyMarkup: (
    chatId: string | number,
    messageId: string | number,
    buttons: TelegramSendOpts["buttons"],
    opts?: TelegramSendOpts,
  ) => Promise<unknown>;
  loadedFrom: string;
};

/**
 * Multi-strategy loader for the bundled telegram runtime API.
 *
 * The telegram send functions (`sendMessageTelegram` et al.) are NOT part of
 * the plugin SDK published exports on the stock homebrew install — they're
 * inside `<openclaw>/dist/extensions/telegram/runtime-api.js`. We import that
 * file directly via `pathToFileURL` after locating every openclaw install
 * root with the same discovery helper we use for the ACP runtime.
 *
 * Before 0.5.1, `TelegramNotifier` looked for `api.runtime.channel.telegram
 * .sendMessageTelegram` which silently returned `undefined` on every host —
 * so every Telegram notification (start / progress / done / escalation /
 * verbose / menu) was a no-op.
 */
export async function loadTelegramSdk(logger: Logger): Promise<TelegramSdk | null> {
  const attempts: string[] = [];

  // Strategy 1 — bare specifier, in case a future openclaw version exports it.
  for (const spec of ["openclaw/plugin-sdk/telegram", "openclaw/extensions/telegram/runtime-api"]) {
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      const send = mod.sendMessageTelegram as TelegramSdk["sendMessage"] | undefined;
      const edit = mod.editMessageTelegram as TelegramSdk["editMessage"] | undefined;
      const editRm = mod.editMessageReplyMarkupTelegram as TelegramSdk["editReplyMarkup"] | undefined;
      if (typeof send === "function") {
        return {
          sendMessage: send,
          editMessage: edit ?? fallbackUnsupported("editMessage"),
          editReplyMarkup: editRm ?? fallbackUnsupported("editReplyMarkup"),
          loadedFrom: `import:${spec}`,
        };
      }
      attempts.push(`${spec}: no sendMessageTelegram`);
    } catch (e) {
      attempts.push(`${spec}: ${(e as Error).message.slice(0, 140)}`);
    }
  }

  // Strategy 2 — file-URL import from any discovered openclaw install root.
  for (const root of findOpenclawRoots()) {
    const candidate = path.join(root, "dist", "extensions", "telegram", "runtime-api.js");
    if (!fs.existsSync(candidate)) {
      attempts.push(`${candidate}: missing`);
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(candidate).href)) as Record<string, unknown>;
      const send = mod.sendMessageTelegram as TelegramSdk["sendMessage"] | undefined;
      const edit = mod.editMessageTelegram as TelegramSdk["editMessage"] | undefined;
      const editRm = mod.editMessageReplyMarkupTelegram as TelegramSdk["editReplyMarkup"] | undefined;
      if (typeof send === "function") {
        logger.info(`[automode] telegram SDK loaded from ${candidate}`);
        return {
          sendMessage: send,
          editMessage: edit ?? fallbackUnsupported("editMessage"),
          editReplyMarkup: editRm ?? fallbackUnsupported("editReplyMarkup"),
          loadedFrom: candidate,
        };
      }
      attempts.push(`${candidate}: no sendMessageTelegram export`);
    } catch (e) {
      attempts.push(`${candidate}: ${(e as Error).message.slice(0, 140)}`);
    }
  }

  logger.warn(
    `[automode] telegram SDK not found — notifications will be no-ops. Attempts:\n  ${attempts.join("\n  ")}`,
  );
  return null;
}

function fallbackUnsupported(op: string): never extends infer T ? T : never {
  return (async () => {
    throw new Error(`telegram SDK '${op}' not available on this openclaw install`);
  }) as never;
}
