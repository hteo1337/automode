import { describe, it, expect } from "vitest";
import { resolveConfig, DEFAULT_CONFIG } from "./config.js";

describe("resolveConfig", () => {
  it("returns defaults when no config", () => {
    const c = resolveConfig(undefined);
    expect(c.defaultAgent).toBe("auto");
    expect(c.fallbackAgents).toEqual(["auto"]);
    expect(c.retryOnErrors.rateLimited).toBe(true);
    expect(c.discoveredAcpxAgents).toEqual([]);
  });

  it("merges partial telegram overrides", () => {
    const c = resolveConfig({ telegram: { chatId: "42" } });
    expect(c.telegram.chatId).toBe("42");
    expect(c.telegram.accountId).toBe(DEFAULT_CONFIG.telegram.accountId);
    expect(c.telegram.enabled).toBe(true);
  });

  it("merges partial retryOnErrors (leaves others default)", () => {
    const c = resolveConfig({ retryOnErrors: { rateLimited: false } });
    expect(c.retryOnErrors.rateLimited).toBe(false);
    expect(c.retryOnErrors.timeout).toBe(true);
  });

  it("discovers acpx agents from root config", () => {
    const root = {
      plugins: {
        entries: {
          acpx: { config: { agents: { codex: { command: "/x" }, kimi: { command: "/y" } } } },
        },
      },
    };
    const c = resolveConfig({}, root);
    expect(c.discoveredAcpxAgents).toEqual(["codex", "kimi"]);
  });

  it("expands ~ in stateDir and registry paths", () => {
    const c = resolveConfig({ stateDir: "~/my-state", agentRegistryPaths: ["~/a", "/abs"] });
    expect(c.stateDir.startsWith("/")).toBe(true);
    expect(c.agentRegistryPaths[0]?.startsWith("/")).toBe(true);
    expect(c.agentRegistryPaths[1]).toBe("/abs");
  });

  it("merges agentRoleMap preserving defaults", () => {
    const c = resolveConfig({ agentRoleMap: { test: "kimi" } });
    expect(c.agentRoleMap.test).toBe("kimi");
    expect(c.agentRoleMap.frontend).toBe("auto"); // default preserved
  });

  it("coerces fallbackAgents entries to strings", () => {
    const c = resolveConfig({ fallbackAgents: ["codex", "kimi"] });
    expect(c.fallbackAgents).toEqual(["codex", "kimi"]);
  });
});
