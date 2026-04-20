# @oc-moth/automode

**Autonomous focus mode for [OpenClaw](https://openclaw.ai).** Give it a goal, walk away, come back when it's done.

```
/automode "fix the failing tests in src/auth and commit a green build"
```

The plugin plans the work, optionally dispatches multiple agents in parallel, runs turn after turn against the [ACP](https://github.com/openclaw/docs) backend of your choice, enforces a tool allow-list, reports progress to Telegram, escalates when it needs a human, and survives gateway restarts.

---

## Features

- **Goal-driven loop** — re-injects the goal every turn to prevent drift; terminates on the agent's `<automode:complete>` sentinel or a turn / time cap.
- **Four execution modes** in one state machine: `goal`, `interval` (cron-like), `paced` (agent self-schedules), and `hybrid` (default — goal + reschedulable).
- **Multi-agent orchestration with automatic fallback** — `defaultAgent: "auto"` auto-discovers every acpx agent configured on your host (claude-bf, codex, kimi, gpt-5.x, …). `fallbackAgents` tries alternatives on rate-limits, timeouts, 5xx, DNS failures, or agent-not-found errors. Planner role labels (`frontend`, `test`, …) route to real agents through `agentRoleMap`.
- **Planner + parallel workers** — a turn 0 planner decides whether to run single-agent or spawn up to N parallel workers (configurable); a coordinator turn merges results.
- **Two-layer safety** — a per-task `CLAUDE_CONFIG_DIR` injects a Claude Code `PreToolUse` hook that blocks denied tools / bash patterns; an OpenClaw `before_tool_call` observer provides second-layer audit.
- **Telegram supervision** — task start / progress (edited in place) / escalation (with approve-deny-stop inline buttons) / done. Plumbs through the installed `telegram` plugin.
- **Crash-resume** — tasks persist to disk and resume automatically on gateway restart.
- **Three control sentinels** the agent can emit to steer the loop: `<automode:complete>`, `<automode:escalate>`, `<automode:reschedule>`.

## Install

```bash
openclaw plugins install @oc-moth/automode
```

This copies the plugin into `~/.openclaw/extensions/automode/` and enables it in your config. Restart the gateway to activate:

```bash
launchctl kickstart -k "gui/$UID/ai.openclaw.gateway"   # macOS launchd
# or
openclaw gateway --force
```

Verify:

```bash
openclaw plugins info automode
# then, from inside any chat channel or the CLI:
/automode doctor
# → reports SDK load path, discovered acpx agents, and effective fallback chain
```

## Usage

### Slash commands (in any channel)

```
/automode <goal>                       # hybrid mode (default)
/automode plan <goal>                  # plan-first — waits for approval
/automode goal <goal>                  # caps-only, no agent-initiated reschedules
/automode paced <goal>                 # agent self-schedules between turns
/automode interval 5m <goal>           # fires every N{s|m|h}
/automode status                       # list tasks
/automode stop <id>                    # kill a running task
/automode pause <id> | resume <id>
/automode inspect <id>                 # full state dump
/automode doctor                       # SDK + agents diagnostic
/automode help
```

### Per-task overrides (flags, 0.1.4+)

Flags can appear anywhere in the argument list; unclaimed tokens become the goal.

```
/automode --agent=kimi "fix the failing tests"         # one-off agent override
/automode -a codex refactor auth module                # short form
/automode --backend=acpx --agent=codex ship 3 prs      # force specific backend
/automode --plan --turns=20 "implement X"              # plan-first + override caps
```

`--backend` is auto-inferred from the agent name when omitted: any agent
matching `claude*` / `opus` / `sonnet` / `haiku` routes through the fast
`claude-acp` pool; everything else uses the generic `acpx` runtime.

### Sticky per-host defaults (0.1.4+)

Save a default that survives gateway restarts and applies to every `/automode`
call unless a flag overrides it.

```
/automode use codex                    # set default agent
/automode use kimi --backend=acpx      # pin both
/automode verbose 2                    # sticky verbosity
/automode defaults                     # show current sticky defaults
/automode reset-defaults               # clear
```

**Resolution order (highest → lowest):** flags → sticky prefs → plugin config.

### Autonomy levels (0.2.0+)

Controls how eagerly the task proceeds without human approval. The **tool
denylist is enforced at every level** — autonomy is never a license to wipe
your home directory.

| Level | Plan-first auto-approved? | Low-confidence plans auto-approved? | Failure streak before escalation | Tool allow/deny enforced? |
| --- | :-: | :-: | :-: | :-: |
| `strict` | no | no | 2 | yes |
| `normal` (default) | no | no | 3 | yes |
| `high` | yes | yes | 5 | yes |
| `yolo` | yes | yes | 10 | yes |
| `super-yolo` 🚨 | yes | yes | 999 | **NO** — bypass everything |

**super-yolo disables every tool guard.** Path-scope check, bash denylist
(including built-in obfuscation patterns), tool allowlist — all off. Use
only on a throwaway machine or a VM. Activate via `--super-yolo` / `--unsafe`
/ `-yy` per task, or `/automode super-yolo` for a sticky default.

Per-task:

```
/automode --yolo "handle the Outlook task end to end"
/automode -y --agent=kimi "take it from here"
/automode --autonomy=high --verbose=2 "run the deploy script and watch"
```

Sticky for this host:

```
/automode yolo                # shortcut for autonomy=yolo
/automode autonomy high
/automode defaults            # shows sticky level
```

Config (`plugins.entries.automode.config.autonomy: "yolo"`) gives a host-wide
default.

### Safety hardening shipped in 0.2.0

- **Path-scope enforcement** — `Edit` / `Write` / `NotebookEdit` blocked when
  `file_path` is outside `task.cwd ∪ task.scope.paths`. Absolute-path `cd`
  in bash commands also checked.
- **Secret scrubbing** — Anthropic / OpenAI / GitHub / npm / AWS / Slack /
  GCP / JWT / Bearer / generic `token=value` forms redacted in the audit
  JSONL, Telegram output, and `/automode inspect`.
- **Hardened bash denylist** — `eval "$(…)"`, base64-decode-to-shell chains,
  `curl | sh`, `wget | sh`, obfuscated python/perl shell-out patterns.
- **Exponential backoff** — 500ms × 2^N between fallback attempts.

### Cost tracking (0.2.0+)

Each turn snapshots `backend.runtime.getStatus().details.cost` into
`TaskState.totalCostUsd`. Visible in `/automode inspect <id>` and the
Telegram done message.

Set `maxCostUsd` (config or flag) to cap spending; task enters `capped` with
`reason="cost"` once the cap is reached.

### Budgets, dry-run, logs, chaining (0.3.0+)

```
/automode --budget=5 --agent=codex "ship the PR"   # cap this task at $5
/automode budget 25                                # sticky cap for every future task
/automode --dry-run "pretend to handle this"       # simulate; no tools execute
/automode logs <id>                                # gateway log lines for a task
/automode --on-done="/automode status" --on-fail="/automode inspect" "the goal"
```

### Templates (0.3.0+)

Drop YAML files into `~/.openclaw/automode/templates/`:

```yaml
# ~/.openclaw/automode/templates/fix-tests.yaml
name: fix-tests
description: Find and fix failing tests in a path
goalTemplate: "Find every failing test in {{arg}}, fix them, leave a green build."
agent: codex
autonomy: high
maxCostUsd: 2
scopePaths:
  - /Users/hteo/code/repo-a
```

Then:
```
/automode templates                       # list
/automode template fix-tests src/auth     # substitute {{arg}} = "src/auth"
```

### Shadow mode (0.3.0+)

Compare two agents on the same goal, in parallel:
```
/automode shadow -a codex -a kimi "refactor auth module"
# → prints both task ids; inspect each to compare outputs
```

### Cost ledger (0.3.0+)

```
/automode ledger day     # last 24h
/automode ledger week    # last 7d
/automode cost all       # alias; full history
```
Shows total cost, by-status counts, by-agent spend, top-5 most-expensive tasks.

### Multi-channel notifications (0.3.0+)

Telegram is the primary channel. Slack and Discord broadcast task lifecycle
events when configured:

```jsonc
"notifiers": {
  "slack":   { "enabled": true, "channel": "C01234567", "accountId": "default" },
  "discord": { "enabled": true, "channel": "987654321098765432" }
}
```

### OTel metrics (0.3.0+)

If the `diagnostics-otel` OpenClaw plugin is loaded, automode exports counters
automatically:
- `automode.tasks.started{autonomy,backend,dry_run}`
- `automode.tasks.ended{status,autonomy}`
- `automode.turns.total{agent,backend}`
- `automode.tool_calls.total{tool,allowed}`
- `automode.cost.usd{agent,backend}`

No-op when OTel isn't available.

### Verbosity & live inspection (0.1.5+)

```
/automode -vv "fix the failing tests"      # detailed per-turn stream to Telegram
/automode verbose 2                        # sticky: detailed for every future task
/automode tail <id>                        # print last 5 turn records
/automode tail <id> 20                     # last 20 turns
```

| Level | What you see on Telegram per turn |
| :-: | --- |
| 0 | Start · progress edit-in-place · done (current default behaviour) |
| 1 | + one-line `✓ ended turn N in Xs (Y tool calls)` per turn |
| 2 | + `▶ turn N starting` and each `🔧 ToolName args` as it fires |
| 3 | + first ~400 chars of agent output + first ~300 chars of thoughts |

Tail reads the per-turn audit files under `~/.openclaw/automode/tasks/<id>/turns/*.jsonl` — no gateway calls.

### "One default, everything else as fallback"

That's the out-of-box behavior. When you do `/automode use codex`:

- `defaultAgent` = `codex` (your preferred)
- `fallbackAgents` = `["auto"]` (plugin default) — expands at dispatch time to **every other discovered acpx agent**
- Effective chain: `codex → kimi → claude-bf → claude-vertex-opus47 → …`

On a rate-limit / timeout / 5xx on `codex`, the dispatcher walks the chain until one responds. The turn record captures *which* agent actually answered.

### CLI

```
openclaw automode list
openclaw automode start <goal...>
openclaw automode stop <id>
openclaw automode inspect <id>
openclaw automode help
```

## Configuration

All fields are optional. Defaults shown below.

```jsonc
{
  "plugins": {
    "entries": {
      "automode": {
        "enabled": true,
        "config": {
          // Agent selection & fallback (0.1.1+)
          "defaultAgent": "auto",                  // "auto" = first discovered acpx agent
          "fallbackAgents": ["auto"],              // tried in order on retryable errors
          "agentRoleMap": {                        // planner role labels → acpx agents
            "general": "auto", "frontend": "auto", "backend": "auto",
            "test": "auto", "research": "auto", "docs": "auto", "main": "auto"
          },
          "retryOnErrors": {
            "rateLimited": true, "unhealthy": true, "notFound": true,
            "timeout": true,     "network":   true
          },
          "healthProbeEnabled": false,             // call getStatus before each turn
          "maxFallbacks": 3,

          // Runtime
          "backend": "claude-acp",                 // "acpx" | "claude-acp"
          "maxTurns": 50,
          "maxDurationSec": 3600,
          "maxParallel": 3,
          "parallelismPolicy": "auto",             // "auto"|"ask"|"never"|"always"
          "planFirstThreshold": 0.7,

          // Safety
          "allowedTools": ["Read","Grep","Glob","Edit","Write","TaskCreate","TaskUpdate","TaskList","NotebookEdit","Bash"],
          "deniedBashPatterns": [
            "^\\s*rm\\s+-rf\\s+[/~]",
            "^\\s*sudo\\b",
            "git\\s+push\\s+(-f|--force)",
            "git\\s+reset\\s+--hard",
            "curl\\b.*\\|\\s*(bash|sh)\\b"
          ],

          // Supervision
          "telegram": { "enabled": true, "accountId": "default", "chatId": "<your chat id>" },
          "escalationTimeoutSec": 300,
          "stateDir": "~/.openclaw/automode",
          "schedulerTickMs": 5000
        }
      }
    }
  }
}
```

## Non-Claude backends & auto-fallback (0.1.1+)

Most users never configure anything — automode reads your `plugins.entries.acpx.config.agents` at boot and picks the first one. Example: you have `codex` and `kimi` configured in acpx (no Claude at all). Run:

```
/automode "add unit tests for src/parser.ts"
```

At boot the log shows:
```
[automode] discovered acpx agents: codex, kimi
```

The runner uses `codex` by default, and if `codex` returns a 429 / 502 / timeout, it transparently falls back to `kimi` — no config change needed.

### Pin a preferred agent but allow fallbacks

```jsonc
"config": {
  "defaultAgent": "kimi",
  "fallbackAgents": ["codex", "auto"]    // kimi first, then codex, then anything else discovered
}
```

### Disable fallback entirely (strict single-agent)

```jsonc
"config": {
  "defaultAgent": "codex",
  "fallbackAgents": [],
  "retryOnErrors": {
    "rateLimited": false, "unhealthy": false, "notFound": false,
    "timeout": false,     "network":   false
  }
}
```

### Route planner roles to specific agents (parallel mode)

When a task decomposes into parallel subtasks, the planner emits role labels. You can route them to different backends:

```jsonc
"config": {
  "parallelismPolicy": "always",
  "agentRoleMap": {
    "frontend": "codex",
    "test":     "kimi",
    "research": "kimi",
    "backend":  "codex"
  }
}
```

### Error classes considered retryable

| Class | Triggers on |
| --- | --- |
| `rateLimited` | HTTP 429, messages containing "rate limit" |
| `unhealthy` | HTTP 5xx, "overloaded", "unavailable", "bad gateway" |
| `notFound` | HTTP 404, "unknown agent", "not found" |
| `timeout` | `ETIMEDOUT`, "deadline", "timeout" |
| `network` | `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, DNS failures |

Anything else (assertion errors, malformed config, authorization failures) is `fatal` and terminates the task immediately.

## The three control sentinels

The agent steers the loop by emitting **one** of these in its output (XML-style tags, sentinel lines, or tool-call-style are all detected):

| Purpose | Tag form | Sentinel form |
| --- | --- | --- |
| Declare goal achieved | `<automode:complete>summary</automode:complete>` | `AUTOMODE_COMPLETE: summary` |
| Ask for a human decision | `<automode:escalate severity="warn">reason</automode:escalate>` | `AUTOMODE_ESCALATE: warn \| reason` |
| Self-schedule | `<automode:reschedule seconds="300">note</automode:reschedule>` | `AUTOMODE_RESCHEDULE: 300 \| note` |

If none is emitted, the supervisor assumes the agent wants another turn.

## How it fits OpenClaw

- `register(api)` wires: `registerService` (scheduler lifecycle), `registerCommand` (`/automode`), `registerCli` (`openclaw automode …`), `on("before_tool_call")` (Layer 2 observer), `registerHttpRoute("/automode/cb")` (Telegram callback landing pad).
- Dispatches via `getAcpRuntimeBackend(id)` → `runtime.ensureSession()` → `runtime.runTurn()` — works with both the bundled `acpx` backend and the persistent `claude-acp` pool (recommended, ~10× faster).
- The `PreToolUse` hook is generated per-task and lives entirely inside `~/.openclaw/automode/tasks/<id>/claude-config/` — no pollution of your global `~/.claude/settings.json`.

## Development

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # vitest (55 tests)
```

No build step — OpenClaw loads `*.ts` at runtime via jiti.

Layout:

```
index.ts                    register(api) entry
openclaw.plugin.json        manifest + JSON Schema + UI hints
src/
  commands.ts               /automode subcommand router
  config.ts, types.ts
  engine/                   state machine, runner, supervisor, planner, scheduler, persistence
  agents/                   ACP dispatcher, parallel worker pool, agent registry scan
  safety/                   allow-list rules, per-task wrapper + PreToolUse hook generator
  telegram/                 notifier + callback parser
  tools/                    sentinel detectors (complete / escalate / reschedule)
skills/automode/SKILL.md    agent-facing docs on the three sentinels
```

## License

MIT. See [LICENSE](./LICENSE).
