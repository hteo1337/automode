import { describe, it, expect } from "vitest";
import {
  buildAgentChain,
  classifyError,
  DEFAULT_RETRY_POLICY,
  mapRoleToAgent,
} from "./fallback.js";

describe("buildAgentChain", () => {
  it("preferred 'auto' + discovered yields discovered order", () => {
    const c = buildAgentChain({
      preferred: "auto",
      explicitFallbacks: [],
      discovered: ["codex", "kimi"],
    });
    expect(c).toEqual(["codex", "kimi"]);
  });

  it("preferred concrete id goes first", () => {
    const c = buildAgentChain({
      preferred: "kimi",
      explicitFallbacks: [],
      discovered: ["codex", "kimi"],
    });
    expect(c).toEqual(["kimi", "codex"]);
  });

  it("explicit fallbacks slot in before the rest of discovered", () => {
    const c = buildAgentChain({
      preferred: "kimi",
      explicitFallbacks: ["codex"],
      discovered: ["codex", "kimi", "claude-bf"],
    });
    expect(c).toEqual(["kimi", "codex", "claude-bf"]);
  });

  it("dedupes across sources", () => {
    const c = buildAgentChain({
      preferred: "codex",
      explicitFallbacks: ["codex", "codex"],
      discovered: ["codex"],
    });
    expect(c).toEqual(["codex"]);
  });

  it("auto in fallbacks expands full discovered", () => {
    const c = buildAgentChain({
      preferred: "kimi",
      explicitFallbacks: ["auto"],
      discovered: ["codex", "kimi", "claude-bf"],
    });
    expect(c).toEqual(["kimi", "codex", "claude-bf"]);
  });

  it("appends defaultHint as final safety net", () => {
    const c = buildAgentChain({
      preferred: "kimi",
      explicitFallbacks: [],
      discovered: [],
      defaultHint: "claude-bf",
    });
    expect(c).toContain("claude-bf");
  });

  it("respects maxLength cap", () => {
    const c = buildAgentChain({
      preferred: "a",
      explicitFallbacks: ["b", "c", "d", "e"],
      discovered: [],
      maxLength: 3,
    });
    expect(c).toEqual(["a", "b", "c"]);
  });

  it("never returns an empty chain", () => {
    const c = buildAgentChain({
      preferred: "weird",
      explicitFallbacks: [],
      discovered: [],
    });
    expect(c.length).toBeGreaterThan(0);
  });

  it("auto + no discoveries returns just ['auto'] (dispatcher fails fast)", () => {
    const c = buildAgentChain({
      preferred: "auto",
      explicitFallbacks: ["auto"],
      discovered: [],
      defaultHint: "auto",
    });
    expect(c).toEqual(["auto"]);
  });
});

describe("classifyError", () => {
  const pol = DEFAULT_RETRY_POLICY;

  it("classifies rate limit", () => {
    expect(classifyError(new Error("HTTP 429 Too Many Requests"), pol).kind).toBe("rateLimited");
  });
  it("classifies 5xx as unhealthy", () => {
    expect(classifyError(new Error("upstream returned 502 Bad Gateway"), pol).kind).toBe("unhealthy");
  });
  it("classifies not found", () => {
    expect(classifyError(new Error("unknown agent 'kimi'"), pol).kind).toBe("notFound");
    expect(classifyError(new Error("404 not found"), pol).kind).toBe("notFound");
  });
  it("classifies timeout", () => {
    expect(classifyError(new Error("ETIMEDOUT on stream"), pol).kind).toBe("timeout");
  });
  it("classifies network errors", () => {
    expect(classifyError(new Error("ECONNREFUSED"), pol).kind).toBe("network");
    expect(classifyError(new Error("DNS lookup failed"), pol).kind).toBe("network");
  });
  it("defaults unknown to fatal (not retryable)", () => {
    const c = classifyError(new Error("assertion boom"), pol);
    expect(c.kind).toBe("fatal");
    expect(c.retryable).toBe(false);
  });
  it("policy can disable a class", () => {
    const strict = { ...pol, rateLimited: false };
    const c = classifyError(new Error("HTTP 429"), strict);
    expect(c.kind).toBe("rateLimited");
    expect(c.retryable).toBe(false);
  });
  it("handles non-Error inputs", () => {
    expect(classifyError("timeout exceeded", pol).kind).toBe("timeout");
    expect(classifyError({ code: "E_X" }, pol).kind).toBe("fatal");
  });
});

describe("mapRoleToAgent", () => {
  const discovered = ["codex", "kimi", "claude-bf"];
  const roleMap = { frontend: "kimi", test: "auto" };

  it("passes concrete acpx id through", () => {
    expect(mapRoleToAgent("codex", discovered, roleMap, "auto")).toBe("codex");
  });
  it("maps role via roleMap", () => {
    expect(mapRoleToAgent("frontend", discovered, roleMap, "auto")).toBe("kimi");
  });
  it("'auto' in roleMap yields first discovered", () => {
    expect(mapRoleToAgent("test", discovered, roleMap, "auto")).toBe("codex");
  });
  it("falls back to defaultAgent if no map match", () => {
    expect(mapRoleToAgent("unknown", discovered, roleMap, "claude-bf")).toBe("claude-bf");
  });
  it("uses discovered[0] if defaultAgent is 'auto'", () => {
    expect(mapRoleToAgent("unknown", discovered, roleMap, "auto")).toBe("codex");
  });
  it("preserves role string when nothing else works", () => {
    expect(mapRoleToAgent("weird", [], {}, "auto")).toBe("weird");
  });
});
