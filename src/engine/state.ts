import fs from "node:fs";
import path from "node:path";
import { taskPaths, ensureTaskDirs, type TaskPaths } from "./paths.js";
import type { TaskState, TurnRecord, Escalation } from "../types.js";

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export class TaskStore {
  constructor(private readonly stateDir: string) {
    fs.mkdirSync(path.join(stateDir, "tasks"), { recursive: true });
  }

  paths(taskId: string): TaskPaths {
    return taskPaths(this.stateDir, taskId);
  }

  save(state: TaskState): void {
    const p = this.paths(state.id);
    ensureTaskDirs(p);
    state.updatedAt = Date.now();
    atomicWriteJson(p.state, state);
  }

  load(taskId: string): TaskState | null {
    const p = this.paths(taskId);
    if (!fs.existsSync(p.state)) return null;
    try {
      const raw = fs.readFileSync(p.state, "utf8");
      const state = JSON.parse(raw) as TaskState;
      migrateTaskOnLoad(state);
      return state;
    } catch {
      return null;
    }
  }

  listTaskIds(): string[] {
    const tasksDir = path.join(this.stateDir, "tasks");
    if (!fs.existsSync(tasksDir)) return [];
    return fs
      .readdirSync(tasksDir)
      .filter((name) => fs.existsSync(path.join(tasksDir, name, "state.json")));
  }

  listAll(): TaskState[] {
    const ids = this.listTaskIds();
    const out: TaskState[] = [];
    for (const id of ids) {
      const s = this.load(id);
      if (s) out.push(s);
    }
    return out;
  }

  listRunning(): TaskState[] {
    return this.listAll().filter((s) =>
      ["pending", "planning", "running", "waiting", "escalating", "paused"].includes(s.status),
    );
  }

  appendTurn(taskId: string, turn: TurnRecord): void {
    const p = this.paths(taskId);
    ensureTaskDirs(p);
    const file = path.join(p.turns, `${String(turn.index).padStart(4, "0")}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(turn) + "\n");
  }

  saveEscalation(taskId: string, esc: Escalation): void {
    const p = this.paths(taskId);
    ensureTaskDirs(p);
    atomicWriteJson(path.join(p.escalations, `${esc.id}.json`), esc);
  }

  loadEscalation(taskId: string, escId: string): Escalation | null {
    const p = this.paths(taskId);
    const file = path.join(p.escalations, `${escId}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Escalation;
    } catch {
      return null;
    }
  }
}

export function newTaskId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `t${ts}-${rnd}`;
}

/**
 * Rewrite known-bad fields when an older task state is read from disk.
 * Runs in-place and is idempotent. Current migrations:
 *
 * - `task.telegram.chatId === "telegram" | "slack" | "discord"`: 0.1–0.3.2
 *   saved channel-kind labels verbatim; strip so the notifier falls back to
 *   configured chatId. See CHANGELOG 0.3.4.
 */
export function migrateTaskOnLoad(state: TaskState): void {
  const t = state.telegram;
  if (t && typeof t.chatId === "string") {
    const v = t.chatId.trim();
    if (v === "telegram" || v === "slack" || v === "discord" || v === "") {
      delete t.chatId;
    }
  }
}
