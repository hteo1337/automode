import { describe, it, expect } from "vitest";
import { normalizeTaskChatId } from "./notifier.js";

describe("normalizeTaskChatId", () => {
  it("returns fallback when task chatId is unset", () => {
    expect(normalizeTaskChatId(undefined, "fallback-42")).toBe("fallback-42");
    expect(normalizeTaskChatId("", "fallback-42")).toBe("fallback-42");
    expect(normalizeTaskChatId("   ", "fallback-42")).toBe("fallback-42");
  });

  it("falls back when task chatId is a channel kind literal", () => {
    expect(normalizeTaskChatId("telegram", "real-chat")).toBe("real-chat");
    expect(normalizeTaskChatId("slack", "real-chat")).toBe("real-chat");
    expect(normalizeTaskChatId("discord", "real-chat")).toBe("real-chat");
    expect(normalizeTaskChatId(" telegram ", "real-chat")).toBe("real-chat");
  });

  it("preserves legitimate namespaced chat ids", () => {
    expect(normalizeTaskChatId("telegram:8743540866", "fallback")).toBe(
      "telegram:8743540866",
    );
    expect(normalizeTaskChatId("-1003775571625", "fallback")).toBe("-1003775571625");
    expect(normalizeTaskChatId("C01234567", "fallback")).toBe("C01234567"); // slack-style
  });

  it("returns undefined when task is bogus and no fallback", () => {
    expect(normalizeTaskChatId("telegram", undefined)).toBeUndefined();
    expect(normalizeTaskChatId(undefined, undefined)).toBeUndefined();
  });
});
