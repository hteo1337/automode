import fs from "node:fs";
import path from "node:path";

import type { AutonomyLevel, VerbosityLevel } from "../types.js";

export type Prefs = {
  defaultAgent?: string;
  defaultBackend?: "acpx" | "claude-acp";
  verbosity?: VerbosityLevel;
  autonomy?: AutonomyLevel;
  budgetUsd?: number;
  updatedAt?: number;
};

/**
 * Per-host sticky defaults for automode. Written to
 * `<stateDir>/defaults.json` so restarts and new sessions inherit them.
 * Flags on `/automode` always win; prefs win over plugin config; plugin
 * config is the final fallback.
 */
export class Preferences {
  private readonly file: string;
  private cached: Prefs | null = null;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "defaults.json");
  }

  get(): Prefs {
    if (this.cached) return this.cached;
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, "utf8");
        const parsed = JSON.parse(raw) as Prefs;
        this.cached = parsed;
        return parsed;
      }
    } catch {
      // fall through to empty
    }
    this.cached = {};
    return this.cached;
  }

  set(patch: Partial<Prefs>): Prefs {
    const merged: Prefs = {
      ...this.get(),
      ...patch,
      updatedAt: Date.now(),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cached = merged;
    return merged;
  }

  reset(): void {
    try {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    } catch {
      // ignore
    }
    this.cached = {};
  }
}

/**
 * Infer the right ACP backend from the agent id when the user didn't choose
 * one explicitly. Claude-family agents run fastest through the persistent
 * `claude-acp` pool; everything else uses the generic `acpx` runtime.
 */
export function inferBackend(agent: string): "acpx" | "claude-acp" {
  const a = (agent ?? "").toLowerCase();
  if (/^claude|\bclaude-|opus|sonnet|haiku|vertex-opus|claude-bf/.test(a)) {
    return "claude-acp";
  }
  return "acpx";
}
