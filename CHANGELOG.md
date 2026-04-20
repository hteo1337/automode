# Changelog

All notable changes to `@oc-moth/automode` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] — 2026-04-20

### Fixed — Optional Fix C from the 0.3.3 bug report
- **Self-healing task state on load.** `TaskStore.load` now passes the
  deserialized state through `migrateTaskOnLoad`, which strips bogus
  `task.telegram.chatId` values (`"telegram"` / `"slack"` / `"discord"` /
  whitespace-only) left over from 0.1–0.3.2. After migration, the next
  `store.save()` persists the cleaned value, so `state.json` on disk
  no longer shows the ugly literal.
- This is redundant with the notifier's `normalizeTaskChatId` (0.3.3) at
  runtime, but closes the loop for any **other** reader of
  `task.telegram.chatId` (e.g. `/automode inspect`, future tooling, JSON
  export) that doesn't route through the notifier.
- `migrateTaskOnLoad` is idempotent and exported for unit testing.

## [0.3.3] — 2026-04-20

Fixes two Telegram-routing bugs reported and patched locally by the user.
Progress / verbose / done messages were silently vanishing on direct-chat
invocations because the wrong chat id was being stored on the task.

### Fixed — chatId capture
- **`CommandCtx.channel` is a channel KIND, not a chat id.** In Telegram
  direct messages it arrives as the literal string `"telegram"`. 0.1–0.3.2
  stored that verbatim as `task.telegram.chatId`, so the notifier later
  called `sendMessageTelegram("telegram", …)` which routes nowhere.
- New helper `resolveTaskChatId(ctx, cfg)` in `src/commands.ts`:
  - kind-only channel + `senderId` → `"telegram:<senderId>"`
  - already-namespaced channel (contains `:`) → use as-is
  - otherwise → fall back to the configured `telegram.chatId`
- Applied at all three start paths: normal `/automode <goal>`, template
  start, and shadow fan-out.

### Fixed — notifier fallback hardening
- Even after the capture bug was fixed forward, existing tasks on disk
  still carried `"telegram"` as their chat id and would have routed to the
  wrong place after crash-resume.
- New `normalizeTaskChatId(chatId, fallback)` in
  `src/telegram/notifier.ts` rejects the three channel-kind literals
  (`telegram` / `slack` / `discord`) and whitespace-only values,
  transparently falling back to the configured `telegram.chatId`.
- Applied in both `enabled(task?)` and `resolveChat(task)` — the two
  places the notifier decides where a message goes.

### Credits
Bug reported and fixed locally by the user. This release merges those
patches verbatim (with tests added).

## [0.3.2] — 2026-04-20

Long-task stability pass. Fixes gateway hang / restart / OOM under long
autonomous runs (particularly in yolo mode, where the task runs many turns
without human checkpoints).

### Fixed — memory
- **Per-turn event buffer cap** (2000 events). After the cap we count
  overflow but stop allocating.
- **Per-turn output cap** (64 KB for agent output, 32 KB for thoughts).
  Prevents a chatty agent from filling the gateway heap.
- When caps fire, a one-line summary lands in the gateway log:
  `turn N buffers capped: events+X output+Yc thought+Zc`.

### Fixed — event loop starvation
- **Yield every 100 events** inside the runner's async iterator
  (`setImmediate`) so other plugins, Telegram ingress, and the gateway
  heartbeat keep getting cycles on dense turns.
- **Yield once per turn** in the scheduler's outer loop.
- **Heartbeat log every 10 turns**: `[automode] <id> heartbeat: turn N,
  cost $…` — gives visible progress without requiring verbose mode.

### Fixed — hang prevention
- **Telegram send timeout** (10s) wraps every `sendMessageTelegram` and
  `editMessageTelegram`. A stuck network request can no longer block the
  task's progress path.
- **Per-turn watchdog** (10 min). If a turn neither emits `done` nor
  errors within the window, the runner records a watchdog error and
  returns to the scheduler (which decides to retry, escalate, or fail
  based on autonomy).

### Fixed — Telegram flooding
- **Verbose notification throttler**: 2 messages/sec per task, burst 6.
  Anything beyond is dropped; the next emitted line carries a
  `(+N dropped)` prefix so users know something was suppressed. Eliminates
  the thousands-of-pending-promises pileup that happened on tool-heavy
  turns at `verbose=2/3`.
- Per-task throttler is released when the task ends, preventing a slow
  memory leak across many tasks in the same gateway.

### Added
- New module `src/telegram/throttle.ts` with `makeThrottler` and
  `withTimeout`. Both have unit tests covering burst, refill, drop
  counting, and timer cleanup.

## [0.3.1] — 2026-04-20

### Fixed
- **Dry-run now actually dry.** 0.3.0 dispatched a real planner turn before
  the dry-run short-circuit fired. The check is now at the top of the loop
  — zero backend calls, zero tokens spent.
- **Empty-discovery + `defaultAgent="auto"` failure mode.** When no acpx
  agents are configured and defaultAgent is "auto", the chain builder used
  to produce a single `"auto"` literal that the backend would 404 on.
  Dispatcher now fails fast with an actionable message: "no acpx agents
  available. Configure plugins.entries.acpx.config.agents…".

### Added
- CLI flags on `openclaw automode start`: `--dry-run`, `--backend`,
  `--autonomy`, `--verbose`, `--budget`. Previously only `--plan` and
  `--agent` were wired.

## [0.3.0] — 2026-04-20

The "do-all-of-them" release. Ten feature areas land in one drop, organised
by capability.

### Added — budgets
- **`--budget=<USD>`** per-task flag and **`/automode budget <USD>`** sticky
  (0 disables). Integrates with the existing `maxCostUsd` cap; flag > prefs >
  config resolution order.

### Added — live task audit
- **`/automode logs <id>`** — tails the gateway log (~/.openclaw/logs/*.log)
  filtered to lines mentioning the task id or the `[automode]` prefix.

### Added — safety
- **Layer 2 turn cancellation.** The `before_tool_call` observer now aborts
  the in-flight `runTurn` when it sees a denylisted tool call that Layer 1
  somehow missed. Skipped when autonomy is `super-yolo`. Belt-and-braces.

### Added — simulation
- **Dry-run mode** via `--dry-run` / `--dry` / `-n`. Bypasses the ACP
  dispatch entirely; records a synthetic turn and marks the task `done`.
  Useful for validating flags/templates before paying for real turns.

### Added — reuse
- **Task templates** — YAML files at `~/.openclaw/automode/templates/*.yaml`.
  - `/automode templates` lists them, `/automode template <name> [args]`
    runs one, with `{{arg}}` substitution in `goalTemplate`.
  - Supported fields: `name`, `description`, `goal`, `goalTemplate`,
    `agent`, `backend`, `autonomy`, `verbosity`, `maxTurns`,
    `maxDurationSec`, `maxCostUsd`, `scopePaths`, `onDone`, `onFail`.

### Added — composition
- **Task chaining.** `onDone` and `onFail` (config or `--on-done=…` /
  `--on-fail=…` flags) dispatch a follow-up slash command after a task
  settles. Chained commands share the owner's channel context.

### Added — fan-out
- **Shadow mode** — `/automode shadow -a <agent1> -a <agent2> [-a …] <goal>`.
  Spawns N parallel tasks with identical goals on different agents. Each
  task records `shadowPeers: [ids…]` for comparison. Inspect per task.

### Added — multi-channel
- **`MultiChannelNotifier`** broadcasts start / escalation / done to
  Telegram (primary) plus optional Slack / Discord sidekicks. Config:
  `notifiers.slack.enabled`, `notifiers.slack.channel`,
  `notifiers.discord.enabled`, `notifiers.discord.channel`. Uses
  `api.runtime.channel.slack.sendTextSlack` / `.discord.sendTextDiscord`
  when the respective plugin is installed; gracefully no-ops otherwise.

### Added — metrics
- **OTel counters** when `api.runtime.otel.meter` is available:
  `automode.tasks.started{autonomy,backend,dry_run}`,
  `automode.tasks.ended{status,autonomy}`,
  `automode.turns.total{agent,backend}`,
  `automode.tool_calls.total{tool,allowed}`,
  `automode.cost.usd{agent,backend}`. No-op when `diagnostics-otel` isn't
  loaded — zero overhead when inactive.

### Added — analysis
- **Cost ledger** via `/automode ledger [day|week|month|all]` (alias
  `/automode cost`). Aggregates total cost, turn count, status
  distribution, and per-agent spend. Top-5 most-expensive tasks listed.

### Changed
- `TaskState` gains `dryRun`, `onDone`, `onFail`, `templateName`, and
  `shadowPeers` fields (all optional — persistent state is backward compatible).
- `Scheduler` accepts optional `metrics` and `onTaskDone` callback, enabling
  the OTel export and chaining without more plumbing through individual
  task paths.

## [0.2.1] — 2026-04-20

### Added — super-yolo autonomy

A fifth autonomy level, **`super-yolo`**, for users who want the agent to run
with zero safety rails (on a VM, a throwaway machine, or any environment
where full unattended power is acceptable).

- **What it disables**: the entire Layer 1 `PreToolUse` hook collapses to a
  blanket `{"decision":"allow"}`. The path-scope check, bash denylist,
  hardcoded obfuscation patterns, and tool allowlist are all skipped. Layer 2
  stops marking any tool as "denied". Escalation on denied tools is off.
- **What it still does**: turn / duration / cost caps still apply. Secrets
  scrubbing in the audit JSONL still applies. Fallback chain still applies.
  Telegram progress messages still flow. The task record is still persisted.
- **Activation — per task**: `--super-yolo`, `--unsafe`, `--no-guards`, `-yy`.
- **Activation — sticky**: `/automode super-yolo` or `/automode unsafe`.
  Also accepts aliases `bypass`, `no-guard`, `superyolo`.
- **Activation — config**:
  `plugins.entries.automode.config.autonomy: "super-yolo"` (per-host default).
- **Warnings**: on gateway boot if sticky or config default; on every task
  start to the log and to Telegram ("🚨 SUPER-YOLO MODE: all tool guards
  disabled"); on `/automode autonomy` sticky write.

### Rationale

The invariant from 0.2.0 ("autonomy never crosses the tool denylist") was a
deliberate design choice, and it's still the invariant for strict / normal /
high / yolo. `super-yolo` is an explicit, clearly-named escape hatch for the
"let it rip on my dev VM" use case — the name carries the safety warning so
there's no surprise.

## [0.2.0] — 2026-04-20

Major hardening release. Implements every 🔴 high-impact item from `AUDIT.md`
plus autonomy levels in response to a real user running into "paused for
approval" in the middle of what was supposed to be a fully-autonomous task.

### Added — autonomy levels
- **`autonomy`** config field with four tiers: `strict | normal | high | yolo`.
  Default is `normal` (today's behaviour). `high` auto-approves plan-first and
  low-confidence plans. `yolo` auto-approves **everything except a denied
  tool call** — the tool denylist is the bright line no autonomy level can
  cross.
- **`/automode yolo`** (sticky shortcut) and `/automode autonomy <level>`.
- **`--autonomy=<level>`**, **`--yolo`**, **`-y`** flags for per-task overrides.
  Aliases accepted: `careful|paranoid` → `strict`; `balanced|default` →
  `normal`; `fast` → `high`; `full-yolo|auto-approve` → `yolo`.

### Added — safety hardening
- **Path-scope enforcement** in the generated `PreToolUse` hook. `Edit`,
  `Write`, and `NotebookEdit` are blocked when the `file_path` argument
  resolves outside `task.cwd ∪ task.scope.paths`. Absolute-path `cd` targets
  inside bash commands are also checked.
- **Secret scrubbing** via a new `src/safety/scrub.ts` module. 14 rules
  covering Anthropic, OpenAI, GitHub (PAT/OAuth/App/User/Refresh), npm, AWS
  access/session, Slack, GCP, JWT, Bearer headers, and generic
  `token=/api_key=/password=/secret=` key-value form. Applied to every
  `TurnRecord` field (prompt, events, tool args, error, output, thoughts)
  before it hits the on-disk JSONL.
- **Hardened bash denylist** in-code, on top of the user's regex list: blocks
  `eval "$(…)"`, base64-decode-to-shell chains, wget/curl-pipe-to-shell,
  obfuscated `python -c "__import__('os')…"`, and `perl -e …system(…)`.
- **Exponential backoff** between fallback attempts: 500ms × 2^N, capped at
  10s, configurable via `retryBackoffMs`.

### Added — cost & observability
- **Cost tracking**: cumulative USD snapshot from
  `backend.runtime.getStatus().details.cost` stored on
  `TaskState.totalCostUsd`. Shown in `/automode inspect` and the Telegram
  done notification.
- **`maxCostUsd` cap**: when set, the task enters `capped` with
  `reason="cost"` once the cap is reached.
- **Tool-arg truncation**: audit records cap each arg at
  `auditArgMaxChars` (default 2000) with a `…+NNN` suffix.
- **JSON export**: `/automode inspect <id> --json` and `/automode tail <id>
  --json` emit fenced JSON blocks for piping into jq / downstream tooling.

### Added — ergonomics
- **Owner tag on tasks.** `TaskState.owner = { channel, senderId }` captured
  from the invoking `CommandCtx`. Shown in `inspect`. (Enforcement is
  roadmap'd for v0.3.)
- **Boot-time config validation**: warns on unreachable `defaultAgent`,
  empty `fallbackAgents`, and logs when `maxCostUsd` is active.

### Changed
- Config schema adds 5 fields: `autonomy`, `maxCostUsd`, `auditArgMaxChars`,
  `retryBackoffMs`, plus already-present `verbosity`. All backwards-compatible
  with 0.1.x configs (defaults fill in).

### Fixed
- `/automode inspect` now displays cost, owner, and agent/backend in a single
  header line instead of only goal/progress.

## [0.1.5] — 2026-04-20

### Added
- **Verbosity levels 0–3.** Controls how much per-turn detail the plugin
  pushes to Telegram. 0 is silent (only start/progress/done); 1 adds one-line
  turn summaries; 2 adds tool-call names; 3 adds agent output/thought
  snippets. Configurable via `plugins.entries.automode.config.verbosity`,
  per-task `--verbose=N` / `-v` / `-vv` / `-vvv` flags, or sticky
  `/automode verbose <0-3>` for the host.
- **`/automode tail <id> [N]`.** Prints the last N turn records (default 5)
  pulled from the on-disk audit: agent, duration, error, and the last few
  tool calls (blocked calls marked 🚫).
- **`AUDIT.md`** — an honest audit of what's shipped, what's rough, and
  every known failure mode.
- **`ROADMAP.md`** — a prioritized, impact-vs-effort-tagged list of gap
  features staged across v0.2 → v1.0.

### Notes
- All additions are backwards-compatible. Existing configs pick up
  `verbosity: 1` as a default; tasks started under earlier versions load
  cleanly.

## [0.1.4] — 2026-04-20

### Added
- **Inline per-task flags** on `/automode`: `--agent=<id>` (or `-a <id>`),
  `--backend=<acpx|claude-acp>` (or `-b <id>`), `--plan`, `--turns=<n>`,
  `--mins=<n>`. Flags can appear anywhere in the argument list; unclaimed
  tokens form the goal. Example: `/automode --agent=kimi "fix the tests"`.
- **Sticky per-host defaults.** `/automode use <agent>` saves a default that
  survives restarts (written to `<stateDir>/defaults.json`). Pair with
  `/automode use codex --backend=acpx` to pin both. `/automode defaults`
  prints the current state; `/automode reset-defaults` clears it.
- **Smart backend inference.** When the user picks an agent without an
  explicit backend, the plugin now picks `claude-acp` for Claude-family
  agents (matches `claude*`, `opus`, `sonnet`, `haiku`) and `acpx` for
  everything else. Saves cost / latency when the user switches to cheaper
  non-Claude models without forcing them to also edit the backend.
- Doctor output now includes the sticky defaults file contents.

### Resolution order (highest → lowest)
1. `/automode` flag (`--agent=…`, `--backend=…`)
2. Sticky prefs (`/automode use …`)
3. Plugin config (`plugins.entries.automode.config.defaultAgent`)

The chosen agent still flows into the fallback chain built from
`fallbackAgents` + discovered agents — so `default = codex, rest = fallback`
is the natural outcome without any extra config.

## [0.1.3] — 2026-04-20

### Fixed
- **Backend resolution on hosts where `openclaw` is not in the plugin's
  `node_modules` chain.** 0.1.0–0.1.2 imported from `openclaw/plugin-sdk`,
  `/plugin-sdk/acpx`, and `/plugin-sdk/core` — none of which export
  `getAcpRuntimeBackend` on the stock npm package. Now imports from the
  correct subpath `openclaw/plugin-sdk/acp-runtime` via a multi-strategy
  loader (direct import → `createRequire` → file-URL fallback probing common
  global install roots). This matches the pattern the `claude-acp` extension
  uses and makes the plugin resolve the backend cleanly on every install
  layout we've seen (Homebrew, `/usr/local`, Volta, nvm, Windows `%APPDATA%`,
  NemoClaw bundles).

### Added
- **Boot-time SDK preflight.** Runs once when the scheduler service starts
  and logs `SDK preflight ok (via <strategy>: <path>)` or a loud warning if
  the SDK cannot be loaded, so you see the error at gateway start rather
  than at first `/automode` invocation.
- **`/automode doctor` subcommand.** Reports SDK resolution strategy + path,
  every OpenClaw install root found, the configured + discovered agents, and
  the effective fallback chain. Useful for triaging install issues on a new
  host.

## [0.1.2] — 2026-04-20

### Fixed
- Sync `openclaw.plugin.json` version with `package.json`. 0.1.1 shipped with a
  stale `0.1.0` in the plugin manifest; this patch aligns them so
  `openclaw plugins info automode` displays the correct version.

## [0.1.1] — 2026-04-20

### Added
- **Acpx agent auto-discovery.** The plugin now reads
  `plugins.entries.acpx.config.agents` at boot and the new
  `defaultAgent: "auto"` sentinel resolves to the first discovered agent. Same
  package installs cleanly on hosts that use `codex`, `kimi`, any model, or
  mixed backends — no per-host config edit required.
- **Ordered fallback chain (`fallbackAgents`).** On retryable errors
  (rate-limit, 5xx, timeout, network, agent-not-found), the dispatcher walks
  the chain until one agent responds cleanly. `"auto"` entries expand to every
  discovered acpx agent. `maxFallbacks` caps the chain length.
- **Error classification (`retryOnErrors`).** Fine-grained switches decide
  which of `rateLimited | unhealthy | notFound | timeout | network` trigger a
  fallback. Anything else is fatal.
- **Planner role → agent routing (`agentRoleMap`).** The planner's role labels
  (`frontend`, `backend`, `test`, `research`, `docs`, …) now map to concrete
  acpx agents in parallel mode. `"auto"` picks the first discovered agent.
- **Pre-turn health probe (`healthProbeEnabled`).** Optional
  `runtime.getStatus` call before each turn; swap to the next fallback if the
  session is unhealthy.
- **Boot diagnostics.** Logs the discovered acpx agents, or warns when none
  were found with a pointer to configuring them.
- README section "Non-Claude backends & auto-fallback" with recipes for pinned
  defaults, strict single-agent mode, and per-role routing.

### Changed
- `defaultAgent` default changed from `"claude-vertex-opus47"` to `"auto"` —
  works out of the box on any host with at least one acpx agent configured.

## [0.1.0] — 2026-04-20

### Added
- Initial release.
- `/automode` slash command with `plan`, `goal`, `paced`, `hybrid`, `interval`,
  `status`, `stop`, `pause`, `resume`, `inspect`, and `help` subcommands.
- `openclaw automode` CLI with `list`, `start`, `stop`, `inspect`, `help`.
- Unified state machine for four execution modes: `goal`, `interval`, `paced`,
  `hybrid`.
- Turn 0 planner: JSON decomposition, single-agent vs. parallel decision,
  confidence-threshold gated `plan-first` approval flow.
- Parallel worker pool with coordinator-turn merge; auto-picks from the local
  agent registry (`~/.claude/agents` + `~/.openclaw/subagents`, configurable).
- Safety Layer 1: per-task `CLAUDE_CONFIG_DIR` with generated `PreToolUse`
  hook that enforces the tool allow-list and denied bash pattern list.
- Safety Layer 2: `before_tool_call` observer for audit.
- Telegram start / progress (edit-in-place) / escalation (inline approve-deny-
  stop buttons) / done notifications via the installed `telegram` plugin.
- Escalation protocol + `automode.escalate` control sentinel.
- Self-scheduling via `automode.reschedule` control sentinel.
- State persistence with atomic JSON writes; crash-resume on gateway restart.
- HTTP route `/automode/cb` for Telegram callback landing.
- Vitest test suite (55 tests).
