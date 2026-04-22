import fs from "node:fs";
import path from "node:path";
import { expandHome } from "../config.js";

export type TaskTemplate = {
  name: string;
  description?: string;
  goal?: string;
  goalTemplate?: string;   // supports {{arg}} substitution
  agent?: string;
  backend?: "acpx" | "claude-acp" | "openclaw-native";
  autonomy?: "strict" | "normal" | "high" | "yolo" | "super-yolo";
  verbosity?: 0 | 1 | 2 | 3;
  maxTurns?: number;
  maxDurationSec?: number;
  maxCostUsd?: number;
  scopePaths?: string[];
  onDone?: string;
  onFail?: string;
  /**
   * True for templates that ship with automode. Purely informational; set
   * by the store when it yields a built-in definition. User-authored files
   * with the same name override the built-in entry in `list()`/`load()`.
   */
  builtin?: boolean;
};

/**
 * Curated starter templates users can inspect & run without authoring any
 * files. Covers common dev + ops patterns. Listing them via
 * `/automode templates` does NOT run them — the user must still invoke
 * `/automode template <name> <arg>` to start a task.
 */
export const BUILTIN_TEMPLATES: TaskTemplate[] = [
  {
    name: "fix-tests",
    description: "Find and fix failing tests in a path",
    goalTemplate:
      "Find failing tests in {{arg}}, diagnose each failure, apply minimal fixes, " +
      "and re-run until the suite is green. Do not modify tests to pass; fix the code.",
    autonomy: "normal",
    maxTurns: 40,
    maxCostUsd: 2,
  },
  {
    name: "add-tests",
    description: "Add unit tests with ≥80% coverage for a path",
    goalTemplate:
      "Write unit tests for {{arg}} targeting ≥80% line coverage. Cover happy path, " +
      "edge cases, and error paths. Run the suite to confirm all new tests pass.",
    autonomy: "normal",
    maxTurns: 30,
    maxCostUsd: 2,
  },
  {
    name: "review",
    description: "Review recent changes and write findings to REVIEW.md",
    goalTemplate:
      "Review the last 10 commits (or uncommitted diff) touching {{arg}}. Produce a " +
      "REVIEW.md with: risks, correctness issues, missing tests, and suggested follow-ups.",
    autonomy: "strict",
    maxTurns: 20,
    maxCostUsd: 1,
  },
  {
    name: "refactor",
    description: "Readability + dead-code removal, no behavior change",
    goalTemplate:
      "Refactor {{arg}} for readability — extract helpers, remove dead code, rename " +
      "confusing identifiers. Do NOT change external behavior. Verify by running tests.",
    autonomy: "normal",
    maxTurns: 30,
    maxCostUsd: 2,
  },
  {
    name: "bump-deps",
    description: "Safe dep upgrades, tests after each bump",
    goalTemplate:
      "Audit outdated dependencies in {{arg}}. Bump patch/minor versions first, run " +
      "tests after each bump, and roll back any bump that breaks. Produce a summary of " +
      "what was bumped and what was skipped.",
    autonomy: "normal",
    maxTurns: 40,
    maxCostUsd: 3,
  },
  {
    name: "debug",
    description: "Diagnose a failure and propose a fix",
    goalTemplate:
      "Diagnose: '{{arg}}'. Reproduce the failure, trace the call path, identify the " +
      "root cause, and propose (not apply) the minimal fix. Write findings to DEBUG.md.",
    autonomy: "strict",
    maxTurns: 25,
    maxCostUsd: 2,
  },
  {
    name: "doc-sync",
    description: "Sync README / API docs with current code",
    goalTemplate:
      "Update the README and any API reference docs in {{arg}} to match the current " +
      "source. Fix stale examples, regenerate command lists, and flag anything the " +
      "author must review manually.",
    autonomy: "normal",
    maxTurns: 20,
    maxCostUsd: 1,
  },
  {
    name: "deploy-check",
    description: "Pre-deploy sanity: lint + test + typecheck + build",
    goalTemplate:
      "Run pre-deploy checks in {{arg}}: linter, full test suite, type-check, production " +
      "build, and smoke tests if present. Do NOT deploy. Report pass/fail per step and " +
      "any blockers.",
    autonomy: "strict",
    maxTurns: 15,
    maxCostUsd: 1,
  },
  {
    name: "feature",
    description: "Implement a new feature end-to-end with tests",
    goalTemplate:
      "Implement this feature: {{arg}}. Start with a short design note (what/why/tradeoffs) " +
      "in the PR description, then code, then tests. Commit after each logical chunk. " +
      "Ensure type-check + tests + lint all pass before marking done.",
    autonomy: "normal",
    maxTurns: 60,
    maxCostUsd: 5,
  },
  {
    name: "bug-fix",
    description: "Reproduce, root-cause, patch, and add a regression test",
    goalTemplate:
      "Diagnose and fix this bug: {{arg}}. Required steps: (1) reproduce the failure, " +
      "(2) identify the root cause, (3) apply the minimal fix, (4) add a regression test " +
      "that fails before the fix and passes after, (5) run the full suite and confirm green.",
    autonomy: "normal",
    maxTurns: 30,
    maxCostUsd: 2,
  },
  {
    name: "api-endpoint",
    description: "Add a new API endpoint with validation, tests, and docs",
    goalTemplate:
      "Add API endpoint: {{arg}}. Define the request/response contract first, then implement " +
      "the handler with input validation, error paths (4xx + 5xx), and auth if applicable. " +
      "Add unit tests for the handler and at least one integration test. Update API docs.",
    autonomy: "normal",
    maxTurns: 40,
    maxCostUsd: 3,
  },
  {
    name: "migrate",
    description: "Incremental migration: small commits, keep old path alive",
    goalTemplate:
      "Migrate: {{arg}}. Make the change in small, reversible commits. Run tests after each " +
      "commit. Keep the old and new paths functional in parallel until the switchover is " +
      "complete, then remove the old path in a final commit. Report any compatibility breaks.",
    autonomy: "strict",
    maxTurns: 50,
    maxCostUsd: 4,
  },
  {
    name: "perf",
    description: "Profile, optimise, verify with benchmark diff",
    goalTemplate:
      "Profile and optimise: {{arg}}. Establish a baseline benchmark (micro or end-to-end), " +
      "identify the hot path, apply targeted optimisations, and verify improvement with a " +
      "benchmark diff. Do not regress correctness — run the full test suite after each change.",
    autonomy: "normal",
    maxTurns: 35,
    maxCostUsd: 3,
  },
  {
    name: "spike",
    description: "Throwaway proof-of-concept to answer one feasibility question",
    goalTemplate:
      "Feasibility spike: {{arg}}. Build the smallest prototype that answers 'can this work?'. " +
      "Write findings to SPIKE.md: approach, what worked, what didn't, next steps. Do NOT " +
      "worry about tests, polish, or production-readiness. This is a learning artefact.",
    autonomy: "high",
    maxTurns: 25,
    maxCostUsd: 2,
  },
];

/**
 * Minimal YAML-ish loader supporting flat scalar fields and a single level of
 * string arrays (`scopePaths:`). Keeps us free of a YAML dependency — the
 * template surface is small and type-coerced.
 */
export function parseTemplate(text: string, name: string): TaskTemplate {
  const t: TaskTemplate = { name };
  const lines = text.split(/\r?\n/);
  let arrayField: keyof TaskTemplate | null = null;
  let arrayBuf: string[] = [];
  const flushArray = () => {
    if (arrayField === "scopePaths") t.scopePaths = [...arrayBuf];
    arrayField = null;
    arrayBuf = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    if (arrayField) {
      const m = line.match(/^\s*-\s+(.+)$/);
      if (m) {
        arrayBuf.push(stripQuotes(m[1]!));
        continue;
      }
      flushArray();
    }
    const kv = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!;
    if (!value && (key === "scopePaths")) {
      arrayField = key as keyof TaskTemplate;
      arrayBuf = [];
      continue;
    }
    applyKey(t, key, stripQuotes(value));
  }
  flushArray();
  return t;
}

function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function applyKey(t: TaskTemplate, key: string, value: string): void {
  switch (key) {
    case "name":
      t.name = value;
      break;
    case "description":
      t.description = value;
      break;
    case "goal":
      t.goal = value;
      break;
    case "goalTemplate":
      t.goalTemplate = value;
      break;
    case "agent":
      t.agent = value;
      break;
    case "backend":
      if (value === "acpx" || value === "claude-acp" || value === "openclaw-native") t.backend = value;
      break;
    case "autonomy": {
      const v = value as TaskTemplate["autonomy"];
      if (["strict", "normal", "high", "yolo", "super-yolo"].includes(value)) {
        t.autonomy = v;
      }
      break;
    }
    case "verbosity": {
      const n = Number(value);
      if (n >= 0 && n <= 3) t.verbosity = Math.floor(n) as 0 | 1 | 2 | 3;
      break;
    }
    case "maxTurns":
      if (Number.isFinite(Number(value))) t.maxTurns = Math.max(1, Math.floor(Number(value)));
      break;
    case "maxDurationSec":
      if (Number.isFinite(Number(value))) t.maxDurationSec = Math.max(1, Math.floor(Number(value)));
      break;
    case "maxCostUsd":
      if (Number.isFinite(Number(value))) t.maxCostUsd = Math.max(0, Number(value));
      break;
    case "onDone":
      t.onDone = value;
      break;
    case "onFail":
      t.onFail = value;
      break;
    default:
      // ignore unknown keys
      break;
  }
}

/** Substitute `{{arg}}` tokens in `goalTemplate` with user-provided args. */
export function renderGoal(tpl: TaskTemplate, args: string): string {
  const base = tpl.goalTemplate ?? tpl.goal ?? "";
  return base.replace(/\{\{\s*arg\s*\}\}/g, args).replace(/\{\{\s*args\s*\}\}/g, args);
}

export type TemplateStore = {
  dir: string;
  list(): TaskTemplate[];
  load(name: string): TaskTemplate | null;
  /** Create an empty user template. Fails if a user file already exists. */
  create(name: string): { ok: true; path: string } | { ok: false; error: string };
  /** Set one field on a user template. Creates the file if missing. Fails on built-ins. */
  update(
    name: string,
    field: string,
    value: string,
  ): { ok: true; path: string } | { ok: false; error: string };
  /** Delete a user template. Built-ins cannot be deleted. */
  remove(name: string): { ok: true } | { ok: false; error: string };
  /** Copy a built-in into a user YAML so it can be customised. */
  cloneBuiltin(
    builtinName: string,
    newName?: string,
  ): { ok: true; path: string; name: string } | { ok: false; error: string };
};

/** Fields that `template-set` accepts. Anything else is rejected. */
export const EDITABLE_FIELDS = [
  "description",
  "goal",
  "goalTemplate",
  "agent",
  "backend",
  "autonomy",
  "verbosity",
  "maxTurns",
  "maxDurationSec",
  "maxCostUsd",
  "onDone",
  "onFail",
] as const;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

export function isValidTemplateName(name: string): boolean {
  return NAME_RE.test(name);
}

function isBuiltinName(name: string): boolean {
  return BUILTIN_TEMPLATES.some((t) => t.name === name);
}

function userFilePath(dir: string, name: string): string {
  return path.join(dir, `${name}.yaml`);
}

function serializeTemplate(t: TaskTemplate): string {
  // Minimal YAML emitter matching the format parseTemplate can round-trip.
  const lines: string[] = [];
  lines.push(`name: ${t.name}`);
  if (t.description) lines.push(`description: ${quote(t.description)}`);
  if (t.goal) lines.push(`goal: ${quote(t.goal)}`);
  if (t.goalTemplate) lines.push(`goalTemplate: ${quote(t.goalTemplate)}`);
  if (t.agent) lines.push(`agent: ${t.agent}`);
  if (t.backend) lines.push(`backend: ${t.backend}`);
  if (t.autonomy) lines.push(`autonomy: ${t.autonomy}`);
  if (typeof t.verbosity === "number") lines.push(`verbosity: ${t.verbosity}`);
  if (typeof t.maxTurns === "number") lines.push(`maxTurns: ${t.maxTurns}`);
  if (typeof t.maxDurationSec === "number") lines.push(`maxDurationSec: ${t.maxDurationSec}`);
  if (typeof t.maxCostUsd === "number") lines.push(`maxCostUsd: ${t.maxCostUsd}`);
  if (t.onDone) lines.push(`onDone: ${quote(t.onDone)}`);
  if (t.onFail) lines.push(`onFail: ${quote(t.onFail)}`);
  if (t.scopePaths && t.scopePaths.length > 0) {
    lines.push("scopePaths:");
    for (const p of t.scopePaths) lines.push(`  - ${quote(p)}`);
  }
  return lines.join("\n") + "\n";
}

function quote(s: string): string {
  // Always double-quote to avoid ambiguity with ':', '#', etc. Escape
  // embedded double quotes by switching to single quotes.
  if (s.includes('"') && !s.includes("'")) return `'${s}'`;
  const esc = s.replace(/"/g, '\\"');
  return `"${esc}"`;
}

function coerceField(
  field: string,
  value: string,
): { ok: true; patch: Partial<TaskTemplate> } | { ok: false; error: string } {
  const v = value.trim();
  switch (field) {
    case "description":
    case "goal":
    case "goalTemplate":
    case "agent":
    case "onDone":
    case "onFail":
      return { ok: true, patch: { [field]: v } };
    case "backend":
      if (v !== "acpx" && v !== "claude-acp" && v !== "openclaw-native") {
        return { ok: false, error: `backend must be 'acpx', 'claude-acp', or 'openclaw-native'` };
      }
      return { ok: true, patch: { backend: v } };
    case "autonomy":
      if (!["strict", "normal", "high", "yolo", "super-yolo"].includes(v)) {
        return { ok: false, error: `autonomy must be strict|normal|high|yolo|super-yolo` };
      }
      return { ok: true, patch: { autonomy: v as TaskTemplate["autonomy"] } };
    case "verbosity": {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 3) {
        return { ok: false, error: `verbosity must be 0..3` };
      }
      return { ok: true, patch: { verbosity: Math.floor(n) as 0 | 1 | 2 | 3 } };
    }
    case "maxTurns":
    case "maxDurationSec": {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1) {
        return { ok: false, error: `${field} must be a positive integer` };
      }
      return { ok: true, patch: { [field]: Math.floor(n) } };
    }
    case "maxCostUsd": {
      const n = Number(v.replace(/^\$/, ""));
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, error: `maxCostUsd must be a non-negative number` };
      }
      return { ok: true, patch: { maxCostUsd: n } };
    }
    default:
      return {
        ok: false,
        error: `unknown field '${field}'. Editable: ${EDITABLE_FIELDS.join(", ")}`,
      };
  }
}

export function makeTemplateStore(stateDir: string): TemplateStore {
  const dir = path.join(expandHome(stateDir), "templates");
  const readUserTemplates = (): TaskTemplate[] => {
    if (!fs.existsSync(dir)) return [];
    const out: TaskTemplate[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.ya?ml$/i.test(f)) continue;
      try {
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        const name = f.replace(/\.ya?ml$/i, "");
        out.push(parseTemplate(text, name));
      } catch {
        // skip unreadable
      }
    }
    return out;
  };
  return {
    dir,
    list(): TaskTemplate[] {
      const user = readUserTemplates();
      const userNames = new Set(user.map((t) => t.name));
      // User-authored wins on name collision (they're likely a customisation
      // of the built-in). Mark the remaining built-ins so the UI can badge them.
      const builtins = BUILTIN_TEMPLATES
        .filter((t) => !userNames.has(t.name))
        .map((t) => ({ ...t, builtin: true }));
      return [...user, ...builtins].sort((a, b) => a.name.localeCompare(b.name));
    },
    load(name: string): TaskTemplate | null {
      for (const ext of [".yaml", ".yml"]) {
        const p = path.join(dir, `${name}${ext}`);
        if (fs.existsSync(p)) {
          try {
            return parseTemplate(fs.readFileSync(p, "utf8"), name);
          } catch {
            return null;
          }
        }
      }
      const builtin = BUILTIN_TEMPLATES.find((t) => t.name === name);
      return builtin ? { ...builtin, builtin: true } : null;
    },
    create(name) {
      if (!isValidTemplateName(name)) {
        return { ok: false, error: `invalid name '${name}' (allowed: a-z 0-9 _-, up to 40 chars)` };
      }
      if (isBuiltinName(name)) {
        return {
          ok: false,
          error: `'${name}' is a built-in; use /automode template-clone ${name} <new-name> to customise it`,
        };
      }
      fs.mkdirSync(dir, { recursive: true });
      const file = userFilePath(dir, name);
      if (fs.existsSync(file)) return { ok: false, error: `template '${name}' already exists` };
      fs.writeFileSync(file, serializeTemplate({ name }), "utf8");
      return { ok: true, path: file };
    },
    update(name, field, value) {
      if (!isValidTemplateName(name)) {
        return { ok: false, error: `invalid name '${name}'` };
      }
      if (isBuiltinName(name) && !fs.existsSync(userFilePath(dir, name))) {
        return {
          ok: false,
          error: `'${name}' is a built-in; clone it first with /automode template-clone ${name}`,
        };
      }
      const coerced = coerceField(field, value);
      if (!coerced.ok) return coerced;
      fs.mkdirSync(dir, { recursive: true });
      const file = userFilePath(dir, name);
      const existing: TaskTemplate = fs.existsSync(file)
        ? parseTemplate(fs.readFileSync(file, "utf8"), name)
        : { name };
      const merged: TaskTemplate = { ...existing, ...coerced.patch, name };
      fs.writeFileSync(file, serializeTemplate(merged), "utf8");
      return { ok: true, path: file };
    },
    remove(name) {
      if (isBuiltinName(name) && !fs.existsSync(userFilePath(dir, name))) {
        return { ok: false, error: `'${name}' is a built-in and cannot be deleted` };
      }
      let removed = false;
      for (const ext of [".yaml", ".yml"]) {
        const p = path.join(dir, `${name}${ext}`);
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          removed = true;
        }
      }
      if (!removed) return { ok: false, error: `no user template '${name}' to delete` };
      return { ok: true };
    },
    cloneBuiltin(builtinName, newName) {
      const src = BUILTIN_TEMPLATES.find((t) => t.name === builtinName);
      if (!src) return { ok: false, error: `no built-in template '${builtinName}'` };
      const target = newName ?? builtinName;
      if (!isValidTemplateName(target)) {
        return { ok: false, error: `invalid name '${target}'` };
      }
      fs.mkdirSync(dir, { recursive: true });
      const file = userFilePath(dir, target);
      if (fs.existsSync(file)) {
        return { ok: false, error: `user template '${target}' already exists — pick a different name` };
      }
      const copy: TaskTemplate = { ...src, name: target, builtin: undefined };
      fs.writeFileSync(file, serializeTemplate(copy), "utf8");
      return { ok: true, path: file, name: target };
    },
  };
}
