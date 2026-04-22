import { describe, it, expect } from "vitest";
import { discoverAcpxAgents, expandAuto, backendForAgent } from "./discovery.js";

describe("discoverAcpxAgents", () => {
  it("returns empty when config is undefined", () => {
    const d = discoverAcpxAgents(undefined);
    expect(d.ids).toEqual([]);
    expect(d.byCommand).toEqual({});
  });

  it("extracts agent ids from the acpx entry", () => {
    const cfg = {
      plugins: {
        entries: {
          acpx: {
            config: {
              agents: {
                "claude-vertex-opus47": { command: "/x/cv.sh" },
                codex: { command: "/x/codex.sh" },
                kimi: { command: "/x/kimi.sh" },
              },
            },
          },
        },
      },
    };
    const d = discoverAcpxAgents(cfg);
    expect(d.ids).toEqual(["claude-vertex-opus47", "codex", "kimi"]);
    expect(d.byCommand.codex).toBe("/x/codex.sh");
  });

  it("tolerates missing or non-object acpx", () => {
    expect(discoverAcpxAgents({ plugins: {} }).ids).toEqual([]);
    expect(discoverAcpxAgents({ plugins: { entries: { acpx: "not-object" } } }).ids).toEqual([]);
  });

  it("skips non-string keys defensively", () => {
    const cfg = { plugins: { entries: { acpx: { config: { agents: { "": {} } } } } } };
    expect(discoverAcpxAgents(cfg).ids).toEqual([]);
  });

  it("extracts native openclaw agents from agents.list[]", () => {
    const cfg = {
      agents: {
        list: [
          { id: "main", model: { primary: "fireworks/kimi" } },
          { id: "coder", model: { primary: "fireworks/kimi" } },
          { id: "invalid" }, // valid — has string id
          { model: { primary: "x" } }, // skipped — no id
        ],
      },
    };
    const d = discoverAcpxAgents(cfg);
    expect(d.nativeIds).toEqual(["main", "coder", "invalid"]);
    expect(d.acpxIds).toEqual([]);
    expect(d.originById.main).toBe("native");
    expect(d.ids).toEqual(["main", "coder", "invalid"]);
  });

  it("merges acpx + native with acpx winning on origin collision", () => {
    const cfg = {
      plugins: {
        entries: {
          acpx: { config: { agents: { claude: { command: "/x/c.sh" } } } },
        },
      },
      agents: {
        list: [
          { id: "claude", model: { primary: "anthropic/opus" } }, // collides with acpx
          { id: "kimi", model: { primary: "fireworks/kimi" } },
        ],
      },
    };
    const d = discoverAcpxAgents(cfg);
    expect(d.acpxIds).toEqual(["claude"]);
    expect(d.nativeIds).toEqual(["claude", "kimi"]);
    // Flat ids: acpx first, then native not already in acpx
    expect(d.ids).toEqual(["claude", "kimi"]);
    // Origin: collision goes to acpx (ACP wrapper wins)
    expect(d.originById.claude).toBe("acpx");
    expect(d.originById.kimi).toBe("native");
  });

  it("tolerates malformed agents.list", () => {
    expect(discoverAcpxAgents({ agents: { list: "nope" } }).nativeIds).toEqual([]);
    expect(discoverAcpxAgents({ agents: {} }).nativeIds).toEqual([]);
  });
});

describe("backendForAgent", () => {
  const origins = { claude: "acpx" as const, kimi: "native" as const };

  it("routes native agents to openclaw-native", () => {
    expect(backendForAgent("kimi", origins, "acpx")).toBe("openclaw-native");
  });

  it("passes ACP agents through the caller's default backend", () => {
    expect(backendForAgent("claude", origins, "acpx")).toBe("acpx");
    expect(backendForAgent("claude", origins, "claude-acp")).toBe("claude-acp");
  });

  it("falls back to ACP backend for unknown ids", () => {
    expect(backendForAgent("mystery", origins, "claude-acp")).toBe("claude-acp");
  });

  it("avoids routing a mystery ACP agent through openclaw-native", () => {
    expect(backendForAgent("claude", origins, "openclaw-native")).toBe("acpx");
  });
});

describe("expandAuto", () => {
  it("expands 'auto' to all discovered agents", () => {
    expect(expandAuto("auto", ["a", "b"])).toEqual(["a", "b"]);
  });
  it("passes concrete id through", () => {
    expect(expandAuto("claude-bf", ["a", "b"])).toEqual(["claude-bf"]);
  });
  it("returns [] when auto and nothing discovered", () => {
    expect(expandAuto("auto", [])).toEqual([]);
  });
});
