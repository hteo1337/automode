import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTemplate, renderGoal, makeTemplateStore } from "./templates.js";

describe("parseTemplate", () => {
  it("parses flat fields", () => {
    const t = parseTemplate(
      `
name: refactor
description: Refactor one file safely
goal: Refactor the file and run tests
agent: codex
backend: acpx
autonomy: high
verbosity: 2
maxTurns: 20
maxCostUsd: 2.5
onDone: /automode status
`,
      "refactor",
    );
    expect(t.name).toBe("refactor");
    expect(t.goal).toBe("Refactor the file and run tests");
    expect(t.agent).toBe("codex");
    expect(t.backend).toBe("acpx");
    expect(t.autonomy).toBe("high");
    expect(t.verbosity).toBe(2);
    expect(t.maxTurns).toBe(20);
    expect(t.maxCostUsd).toBe(2.5);
    expect(t.onDone).toBe("/automode status");
  });

  it("strips quotes", () => {
    const t = parseTemplate(`goal: "fix the bug"`, "t");
    expect(t.goal).toBe("fix the bug");
  });

  it("parses scopePaths arrays", () => {
    const t = parseTemplate(
      `
name: x
scopePaths:
  - /tmp/a
  - "/tmp/b with spaces"
`,
      "x",
    );
    expect(t.scopePaths).toEqual(["/tmp/a", "/tmp/b with spaces"]);
  });

  it("ignores unknown + malformed keys", () => {
    const t = parseTemplate(
      `
weird: whatever
backend: not-a-valid-backend
autonomy: bogus
`,
      "t",
    );
    expect(t.backend).toBeUndefined();
    expect(t.autonomy).toBeUndefined();
  });

  it("clamps verbosity", () => {
    const t1 = parseTemplate("verbosity: 5", "t");
    expect(t1.verbosity).toBeUndefined();
    const t2 = parseTemplate("verbosity: 2", "t");
    expect(t2.verbosity).toBe(2);
  });
});

describe("renderGoal", () => {
  it("substitutes {{arg}}", () => {
    const t = parseTemplate(`goalTemplate: "fix {{arg}} and commit"`, "t");
    expect(renderGoal(t, "auth.ts")).toBe("fix auth.ts and commit");
  });

  it("falls back to goal when no template", () => {
    const t = parseTemplate(`goal: "just do the thing"`, "t");
    expect(renderGoal(t, "ignored")).toBe("just do the thing");
  });

  it("empty result when neither field set", () => {
    const t = parseTemplate(`name: x`, "x");
    expect(renderGoal(t, "arg")).toBe("");
  });
});

describe("TemplateStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "automode-tpl-"));
  });

  it("returns empty list when dir doesn't exist", () => {
    const store = makeTemplateStore(path.join(dir, "nope"));
    expect(store.list()).toEqual([]);
    expect(store.load("anything")).toBeNull();
  });

  it("lists and loads .yaml files", () => {
    fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "templates", "fix-tests.yaml"),
      `name: fix-tests\ngoal: fix all failing tests`,
    );
    fs.writeFileSync(
      path.join(dir, "templates", "ship-pr.yml"),
      `name: ship-pr\ngoalTemplate: "ship PR for {{arg}}"`,
    );
    const store = makeTemplateStore(dir);
    const list = store.list();
    expect(list.map((t) => t.name).sort()).toEqual(["fix-tests", "ship-pr"]);
    const t = store.load("ship-pr");
    expect(t?.goalTemplate).toBe("ship PR for {{arg}}");
  });

  it("skips non-yaml files", () => {
    fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
    fs.writeFileSync(path.join(dir, "templates", "readme.md"), "hi");
    expect(makeTemplateStore(dir).list()).toEqual([]);
  });
});
