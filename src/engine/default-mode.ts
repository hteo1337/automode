import type { AutomodeConfig } from "../types.js";
import type { Preferences } from "./preferences.js";

/**
 * Decide whether an incoming user message should be routed to automode
 * instead of (or alongside) the normal agent.
 *
 * Layered resolution:
 *   1. Per-chat sticky prefs override config (keyed by the chat id used at
 *      task-start time — so `/automode on` in a DM only affects that DM).
 *   2. Plugin config's `defaultMode.enabled` is the host-wide default.
 *   3. The `gate` determines which messages actually trigger. `any` routes
 *      everything; `verb` matches a verb prefix; `length` requires minWords;
 *      `verbOrLength` is the permissive default.
 */
export type RouteDecision = {
  route: boolean;
  reason: string;
};

export function shouldRouteToAutomode(
  message: string,
  chatId: string | undefined,
  cfg: AutomodeConfig,
  prefs: Preferences | undefined,
): RouteDecision {
  const chatOverride =
    chatId && prefs?.get().chatDefaults
      ? prefs.get().chatDefaults![chatId]
      : undefined;
  const enabled = chatOverride ?? cfg.defaultMode.enabled;
  if (!enabled) return { route: false, reason: "default-mode off" };

  const text = (message ?? "").trim();
  if (!text) return { route: false, reason: "empty message" };

  const gate = cfg.defaultMode.gate;
  if (gate === "any") return { route: true, reason: "gate=any" };

  const words = text.split(/\s+/).filter(Boolean);
  const firstWord = (words[0] ?? "").toLowerCase().replace(/[^a-z-]/g, "");
  const isVerb = cfg.defaultMode.verbs.some((v) => v.toLowerCase() === firstWord);
  const longEnough = words.length >= cfg.defaultMode.minWords;

  switch (gate) {
    case "verb":
      return isVerb
        ? { route: true, reason: `gate=verb matched '${firstWord}'` }
        : { route: false, reason: `gate=verb no match (got '${firstWord}')` };
    case "length":
      return longEnough
        ? { route: true, reason: `gate=length ${words.length}≥${cfg.defaultMode.minWords}` }
        : { route: false, reason: `gate=length ${words.length}<${cfg.defaultMode.minWords}` };
    case "verbOrLength":
      if (isVerb) return { route: true, reason: `gate=verbOrLength matched verb '${firstWord}'` };
      if (longEnough) return { route: true, reason: `gate=verbOrLength length ${words.length}≥${cfg.defaultMode.minWords}` };
      return { route: false, reason: "gate=verbOrLength no match" };
    default:
      return { route: false, reason: `unknown gate '${gate}'` };
  }
}
