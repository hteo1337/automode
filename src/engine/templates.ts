import fs from "node:fs";
import path from "node:path";
import { expandHome } from "../config.js";

export type TaskTemplate = {
  name: string;
  description?: string;
  goal?: string;
  goalTemplate?: string;   // supports {{arg}} substitution
  agent?: string;
  backend?: "acpx" | "claude-acp";
  autonomy?: "strict" | "normal" | "high" | "yolo" | "super-yolo";
  verbosity?: 0 | 1 | 2 | 3;
  maxTurns?: number;
  maxDurationSec?: number;
  maxCostUsd?: number;
  scopePaths?: string[];
  onDone?: string;
  onFail?: string;
};

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
      if (value === "acpx" || value === "claude-acp") t.backend = value;
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
};

export function makeTemplateStore(stateDir: string): TemplateStore {
  const dir = path.join(expandHome(stateDir), "templates");
  return {
    dir,
    list(): TaskTemplate[] {
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
      return out.sort((a, b) => a.name.localeCompare(b.name));
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
      return null;
    },
  };
}
