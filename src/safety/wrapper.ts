import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AutomodeConfig, TaskState } from "../types.js";
import type { TaskPaths } from "../engine/paths.js";

function resolveBaseWrapper(task: TaskState): string {
  const agent = task.config.defaultAgent;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".openclaw", "wrappers", `${agent}-acp.sh`),
    path.join(home, ".claude", "hooks", `${agent}-acp.sh`),
    path.join(home, ".claude", "hooks", `claude-${agent}-acp.sh`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]!;
}

export function buildPreToolUseHook(
  cfg: AutomodeConfig,
  taskId: string,
  taskCwd: string,
  scopePaths: string[],
  disableGuards = false,
): string {
  if (disableGuards) {
    return `#!/usr/bin/env bash
# automode super-yolo PreToolUse hook — generated for task ${taskId}.
# ALL GUARDS DISABLED: every tool call is approved. Do not edit.
# Read and discard the payload; emit an unconditional allow.
cat >/dev/null
echo '{"decision":"allow","reason":"automode super-yolo: guards disabled"}'
exit 0
`;
  }
  const allow = JSON.stringify(cfg.allowedTools);
  const deny = JSON.stringify(cfg.deniedBashPatterns);
  // Resolve scope roots at generation time so the hook doesn't have to.
  const scopeRoots = JSON.stringify(
    [taskCwd, ...scopePaths]
      .filter(Boolean)
      .map((p) => path.resolve(p)),
  );
  return `#!/usr/bin/env bash
# automode PreToolUse hook — generated for task ${taskId}. Do not edit.
set -u
# Read JSON payload from stdin (Claude Code PreToolUse hook format).
payload=$(cat)
node - "$payload" <<'JS'
const path = require("node:path");
const input = process.argv[2] || "";
let msg;
try { msg = JSON.parse(input); } catch { process.exit(0); }
const tool = (msg && msg.tool_name) || (msg && msg.toolName) || "";
const toolInput = (msg && msg.tool_input) || (msg && msg.toolInput) || {};
const command = String(toolInput.command ?? toolInput.cmd ?? "");
const filePath = toolInput.file_path ?? toolInput.filePath ?? toolInput.path ?? toolInput.notebook_path;
const ALLOW = ${allow};
const DENY_BASH = ${deny};
const SCOPE_ROOTS = ${scopeRoots};
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason, tool }));
  process.exit(2);
}
function inScope(absPath) {
  if (SCOPE_ROOTS.length === 0) return true;
  const abs = path.resolve(absPath);
  return SCOPE_ROOTS.some(root => abs === root || abs.startsWith(root + path.sep));
}
if (tool && !ALLOW.some(t => t === tool || t.toLowerCase() === tool.toLowerCase())) {
  block("automode: tool '" + tool + "' not in allowlist");
}
// Path-scope enforcement for write-ish tools.
if (WRITE_TOOLS.has(tool) && typeof filePath === "string" && filePath.length > 0) {
  if (!inScope(filePath)) {
    block("automode: file_path '" + filePath + "' is outside task scope");
  }
}
if (/^bash$/i.test(tool) && command) {
  // Detect cd targets that escape scope.
  const cdMatch = command.match(/(?:^|[;&|]|\\s)cd\\s+("[^"]+"|'[^']+'|[^\\s;&|]+)/);
  if (cdMatch) {
    const raw = cdMatch[1].replace(/^["']|["']$/g, "");
    // Only absolute paths are checked here; relative cd stays inside cwd.
    if (raw.startsWith("/") && !inScope(raw)) {
      block("automode: 'cd " + raw + "' targets path outside scope");
    }
  }
  for (const pat of DENY_BASH) {
    try {
      if (new RegExp(pat).test(command)) {
        block("automode: bash denied by pattern " + pat);
      }
    } catch {}
  }
}
process.stdout.write(JSON.stringify({ decision: "allow", tool }));
JS
rc=$?
echo ""
exit $rc
`;
}

export function buildClaudeSettings(hookPath: string): string {
  return JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: ".*",
            hooks: [{ type: "command", command: hookPath }],
          },
        ],
      },
    },
    null,
    2,
  );
}

export function buildWrapperScript(task: TaskState, paths: TaskPaths): string {
  const base = resolveBaseWrapper(task);
  return `#!/usr/bin/env bash
# automode wrapper — generated for task ${task.id}. Do not edit.
set -u
export CLAUDE_CONFIG_DIR=${JSON.stringify(paths.claudeConfig)}
export AUTOMODE_TASK_ID=${JSON.stringify(task.id)}
export AUTOMODE_TASK_DIR=${JSON.stringify(paths.root)}
exec ${JSON.stringify(base)} "$@"
`;
}

export function installTaskSafety(
  cfg: AutomodeConfig,
  task: TaskState,
  paths: TaskPaths,
): void {
  fs.mkdirSync(paths.claudeConfig, { recursive: true });
  const disableGuards = task.config.autonomy === "super-yolo";
  fs.writeFileSync(
    paths.hookSh,
    buildPreToolUseHook(cfg, task.id, task.cwd, task.scope.paths, disableGuards),
    { encoding: "utf8", mode: 0o700 },
  );
  fs.writeFileSync(paths.claudeSettings, buildClaudeSettings(paths.hookSh), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.writeFileSync(paths.wrapperSh, buildWrapperScript(task, paths), {
    encoding: "utf8",
    mode: 0o700,
  });
}
