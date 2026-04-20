import fs from "node:fs";
import path from "node:path";

export type TaskPaths = {
  root: string;
  state: string;
  turns: string;
  escalations: string;
  workspace: string;
  workers: string;
  claudeConfig: string;
  claudeSettings: string;
  wrapperSh: string;
  hookSh: string;
};

export function taskPaths(stateDir: string, taskId: string): TaskPaths {
  const root = path.join(stateDir, "tasks", taskId);
  const claudeConfig = path.join(root, "claude-config");
  return {
    root,
    state: path.join(root, "state.json"),
    turns: path.join(root, "turns"),
    escalations: path.join(root, "escalations"),
    workspace: path.join(root, "workspace"),
    workers: path.join(root, "workers"),
    claudeConfig,
    claudeSettings: path.join(claudeConfig, "settings.json"),
    wrapperSh: path.join(root, "wrapper.sh"),
    hookSh: path.join(root, "pretooluse-hook.sh"),
  };
}

export function ensureTaskDirs(p: TaskPaths): void {
  for (const dir of [p.root, p.turns, p.escalations, p.workspace, p.workers, p.claudeConfig]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
