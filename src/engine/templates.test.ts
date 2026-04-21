import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTemplate, renderGoal, makeTemplateStore, BUILTIN_TEMPLATES } from "./templates.js";

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

  it("returns only built-ins when user dir doesn't exist", () => {
    const store = makeTemplateStore(path.join(dir, "nope"));
    const list = store.list();
    expect(list.length).toBe(BUILTIN_TEMPLATES.length);
    expect(list.every((t) => t.builtin === true)).toBe(true);
    expect(store.load("anything")).toBeNull();
    expect(store.load("fix-tests")?.builtin).toBe(true);
  });

  it("lists user + built-in, user wins on name collision", () => {
    fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "templates", "fix-tests.yaml"),
      `name: fix-tests\ngoal: fix MY version`,
    );
    fs.writeFileSync(
      path.join(dir, "templates", "ship-pr.yml"),
      `name: ship-pr\ngoalTemplate: "ship PR for {{arg}}"`,
    );
    const store = makeTemplateStore(dir);
    const list = store.list();
    const names = list.map((t) => t.name);
    expect(names).toContain("ship-pr");
    expect(names).toContain("fix-tests");
    // user-authored fix-tests overrides built-in
    const fix = list.find((t) => t.name === "fix-tests")!;
    expect(fix.builtin).toBeUndefined();
    expect(fix.goal).toBe("fix MY version");
    // built-ins other than fix-tests are still present
    expect(names).toContain("review");
  });

  it("loads built-in when no user file exists", () => {
    const store = makeTemplateStore(dir);
    const t = store.load("review");
    expect(t).toBeTruthy();
    expect(t?.builtin).toBe(true);
    expect(t?.goalTemplate).toMatch(/REVIEW\.md/);
  });

  it("user file wins in load()", () => {
    fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "templates", "review.yaml"),
      `name: review\ngoal: my custom review`,
    );
    const t = makeTemplateStore(dir).load("review");
    expect(t?.goal).toBe("my custom review");
    expect(t?.builtin).toBeUndefined();
  });

  it("skips non-yaml files", () => {
    fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
    fs.writeFileSync(path.join(dir, "templates", "readme.md"), "hi");
    const names = makeTemplateStore(dir).list().map((t) => t.name);
    // Built-ins are still present even though no user YAML matched
    expect(names.length).toBe(BUILTIN_TEMPLATES.length);
  });
});

describe("TemplateStore CRUD", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "automode-tpl-crud-"));
  });

  it("creates an empty user template", () => {
    const store = makeTemplateStore(dir);
    const r = store.create("my-tpl");
    expect(r.ok).toBe(true);
    const loaded = store.load("my-tpl");
    expect(loaded?.name).toBe("my-tpl");
    expect(loaded?.builtin).toBeUndefined();
  });

  it("rejects creating with built-in name", () => {
    const store = makeTemplateStore(dir);
    const r = store.create("fix-tests");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/built-in/);
  });

  it("rejects invalid names", () => {
    const store = makeTemplateStore(dir);
    expect(store.create("bad name").ok).toBe(false);
    expect(store.create("Has/Slash").ok).toBe(false);
    expect(store.create("").ok).toBe(false);
  });

  it("rejects creating when user template already exists", () => {
    const store = makeTemplateStore(dir);
    store.create("mine");
    const r = store.create("mine");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/);
  });

  it("updates fields and round-trips through load()", () => {
    const store = makeTemplateStore(dir);
    store.create("mine");
    expect(store.update("mine", "description", "hello world").ok).toBe(true);
    expect(store.update("mine", "goalTemplate", "fix {{arg}}").ok).toBe(true);
    expect(store.update("mine", "autonomy", "high").ok).toBe(true);
    expect(store.update("mine", "maxCostUsd", "$2.5").ok).toBe(true);
    const t = store.load("mine");
    expect(t?.description).toBe("hello world");
    expect(t?.goalTemplate).toBe("fix {{arg}}");
    expect(t?.autonomy).toBe("high");
    expect(t?.maxCostUsd).toBe(2.5);
  });

  it("update rejects unknown fields and invalid values", () => {
    const store = makeTemplateStore(dir);
    store.create("mine");
    expect(store.update("mine", "nope", "x").ok).toBe(false);
    expect(store.update("mine", "autonomy", "ludicrous").ok).toBe(false);
    expect(store.update("mine", "verbosity", "7").ok).toBe(false);
    expect(store.update("mine", "maxTurns", "-1").ok).toBe(false);
  });

  it("update refuses to touch a built-in that hasn't been cloned", () => {
    const store = makeTemplateStore(dir);
    const r = store.update("fix-tests", "description", "nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/clone/i);
  });

  it("clone copies a built-in to a new user file", () => {
    const store = makeTemplateStore(dir);
    const r = store.cloneBuiltin("fix-tests", "my-fix");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe("my-fix");
    const t = store.load("my-fix");
    expect(t?.goalTemplate).toMatch(/failing tests/);
    expect(t?.builtin).toBeUndefined();
  });

  it("clone with no new-name shadows the built-in", () => {
    const store = makeTemplateStore(dir);
    store.cloneBuiltin("review");
    const t = store.load("review");
    expect(t?.builtin).toBeUndefined();
  });

  it("clone rejects an unknown built-in", () => {
    const store = makeTemplateStore(dir);
    const r = store.cloneBuiltin("nonexistent");
    expect(r.ok).toBe(false);
  });

  it("remove deletes user template, refuses built-in", () => {
    const store = makeTemplateStore(dir);
    store.create("trash");
    expect(store.remove("trash").ok).toBe(true);
    expect(store.load("trash")).toBeNull();
    const r = store.remove("fix-tests");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot be deleted/);
  });

  it("remove returns error when no file exists", () => {
    const store = makeTemplateStore(dir);
    const r = store.remove("ghost");
    expect(r.ok).toBe(false);
  });
});
