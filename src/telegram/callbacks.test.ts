import { describe, it, expect } from "vitest";
import { parseCallbackData } from "./callbacks.js";

describe("parseCallbackData", () => {
  it("parses approve", () => {
    const p = parseCallbackData("automode:t123:e456:approve");
    expect(p).toEqual({ kind: "escalation", taskId: "t123", escalationId: "e456", decision: "approve" });
  });

  it("returns null for menu callbacks (handled elsewhere)", () => {
    expect(parseCallbackData("automode:menu:status")).toBeNull();
    expect(parseCallbackData("automode:menu:autonomy:yolo")).toBeNull();
  });

  it("parses deny", () => {
    const p = parseCallbackData("automode:t123:e456:deny");
    expect(p?.decision).toBe("deny");
  });

  it("parses stop", () => {
    expect(parseCallbackData("automode:x:y:stop")?.decision).toBe("stop");
  });

  it("rejects wrong prefix", () => {
    expect(parseCallbackData("other:t:e:approve")).toBeNull();
  });

  it("rejects malformed", () => {
    expect(parseCallbackData("automode:t123")).toBeNull();
    expect(parseCallbackData("")).toBeNull();
  });

  it("rejects unknown decision", () => {
    expect(parseCallbackData("automode:t:e:nuke")).toBeNull();
  });
});
