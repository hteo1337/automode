import { describe, it, expect } from "vitest";
import { parseFlags } from "./flags.js";

describe("parseFlags", () => {
  it("no flags: everything is goal", () => {
    const p = parseFlags("fix the failing tests");
    expect(p.rest).toBe("fix the failing tests");
    expect(p.agent).toBeUndefined();
  });

  it("--agent=<id>", () => {
    const p = parseFlags("--agent=kimi fix the tests");
    expect(p.agent).toBe("kimi");
    expect(p.rest).toBe("fix the tests");
  });

  it("--agent <id> (space)", () => {
    const p = parseFlags("--agent codex do the thing");
    expect(p.agent).toBe("codex");
    expect(p.rest).toBe("do the thing");
  });

  it("-a <id> short form", () => {
    const p = parseFlags("-a kimi refactor auth");
    expect(p.agent).toBe("kimi");
    expect(p.rest).toBe("refactor auth");
  });

  it("--backend=acpx", () => {
    const p = parseFlags("--backend=acpx --agent=codex fix tests");
    expect(p.backend).toBe("acpx");
    expect(p.agent).toBe("codex");
    expect(p.rest).toBe("fix tests");
  });

  it("--plan sets plan flag", () => {
    const p = parseFlags("--plan refactor");
    expect(p.plan).toBe(true);
    expect(p.rest).toBe("refactor");
  });

  it("--turns=10 and --mins=5", () => {
    const p = parseFlags("--turns=10 --mins=5 quick goal");
    expect(p.maxTurns).toBe(10);
    expect(p.maxDurationSec).toBe(300);
    expect(p.rest).toBe("quick goal");
  });

  it("preserves goal ordering with flags in the middle", () => {
    const p = parseFlags("fix --agent=kimi the tests");
    expect(p.agent).toBe("kimi");
    expect(p.rest).toBe("fix the tests");
  });

  it("tolerates unknown flags", () => {
    const p = parseFlags("--weird=1 --agent=kimi goal");
    expect(p.agent).toBe("kimi");
    expect(p.rest).toBe("goal");
  });

  it("--verbose=N sets verbosity", () => {
    expect(parseFlags("--verbose=2 g").verbosity).toBe(2);
    expect(parseFlags("--verbosity 3 g").verbosity).toBe(3);
  });

  it("-v / -vv / -vvv shorthand", () => {
    expect(parseFlags("-v goal").verbosity).toBe(1);
    expect(parseFlags("-vv goal").verbosity).toBe(2);
    expect(parseFlags("-vvv goal").verbosity).toBe(3);
  });

  it("verbosity is clamped to [0,3]", () => {
    expect(parseFlags("--verbose=99 g").verbosity).toBe(3);
    expect(parseFlags("--verbose=-5 g").verbosity).toBe(0);
  });

  it("--autonomy=<level>", () => {
    expect(parseFlags("--autonomy=yolo g").autonomy).toBe("yolo");
    expect(parseFlags("--autonomy high g").autonomy).toBe("high");
    expect(parseFlags("--autonomy=strict g").autonomy).toBe("strict");
  });

  it("--yolo / -y shorthand", () => {
    expect(parseFlags("--yolo g").autonomy).toBe("yolo");
    expect(parseFlags("-y g").autonomy).toBe("yolo");
  });

  it("--super-yolo / -yy / --unsafe / --no-guards shorthand", () => {
    expect(parseFlags("--super-yolo g").autonomy).toBe("super-yolo");
    expect(parseFlags("-yy g").autonomy).toBe("super-yolo");
    expect(parseFlags("--unsafe g").autonomy).toBe("super-yolo");
    expect(parseFlags("--no-guards g").autonomy).toBe("super-yolo");
  });

  it("autonomy aliases", () => {
    expect(parseFlags("--autonomy=fast g").autonomy).toBe("high");
    expect(parseFlags("--autonomy=paranoid g").autonomy).toBe("strict");
  });
});
