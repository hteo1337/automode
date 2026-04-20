import { describe, it, expect } from "vitest";
import { discoverAcpxAgents, expandAuto } from "./discovery.js";

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
