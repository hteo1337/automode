# Changelog

All notable changes to `@oc-moth/automode` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.2] — 2026-05-02

### Fixed — `notifyStart` 400 "message is too long" on long prompts

Long `/automode` goals (1k+ chars, common when default-mode routes a chat
message into automode via the verb-or-length gate) pushed the start
notification past Telegram's 4096-character message limit, causing a
400 from `sendMessage` and no start notification appearing in chat.

- `src/telegram/notifier.ts` — `notifyStart` now truncates the goal to
  1500 chars with a `…(+N chars)` suffix, leaving comfortable headroom
  for the surrounding header lines and markdown formatting.

## [0.6.1] — 2026-05-02

### Fixed — Telegram outbound notifications throw "Telegram API context requires a resolved runtime config"

OpenClaw 2026.4.x's bundled `sendMessageTelegram` validates `opts.cfg` via
`requireRuntimeConfig(opts.cfg, "Telegram API context")`. The plugin's
`TelegramNotifier` did not thread the resolved openclaw runtime config
(`api.config` from `register()`) down to the SDK call sites, so every send
(start / progress / done / escalation / verbose / menu) failed with the
above error and notifications were silently dropped on hosts running the
2026.4.x runtime.

- `index.ts` — `register()` now passes `api.config` as a 4th argument to
  `MultiChannelNotifier`.
- `src/notifiers/multi.ts` — `MultiChannelNotifier` accepts a `runtimeConfig`
  and forwards it to `TelegramNotifier`.
- `src/telegram/notifier.ts` — `TelegramNotifier` stores `runtimeConfig`
  and forwards it to `loadTelegramSdk()`.
- `src/telegram/sdk.ts` — `loadTelegramSdk()` wraps the bundled
  `sendMessageTelegram` / `editMessageTelegram` / `editMessageReplyMarkupTelegram`
  exports so `cfg` is auto-injected into every `opts` object. Existing call
  sites (notifier methods + `index.ts` menu sender) remain untouched. If
  the caller already supplies `cfg` it wins — preserves bare-call semantics
  for future openclaw releases that may thread cfg internally.
- `src/agents/sdk-loader.ts` — `findOpenclawRoots()` now also discovers
  the self-contained install at `~/.openclaw/lib/node_modules/openclaw`,
  so the telegram runtime-api lookup succeeds on hosts that run the
  homebrew sidecar (macOS) or the system-wide npm install (Linux/WSL).

Closes [#1](https://github.com/hteo1337/automode/issues/1).

## [0.6.0] — 2026-04-22

### Added — Native openclaw agent support (new `openclaw-native` backend)
Before 0.6.0, automode only saw agents registered via the `acpx` plugin
(`plugins.entries.acpx.config.agents`). Agents declared in openclaw.json's
top-level `agents.list[]` block — the **native** openclaw agent registry,
e.g. `main`, `coder`, `fast`, `critic` routed to Kimi/Fireworks — were
completely invisible. `/automode doctor` didn't show them, and selecting
one as `defaultAgent` would fail with "ACP backend not registered".

- **New backend id `openclaw-native`** added to the backend union alongside
  `acpx` and `claude-acp`. Manifest enum + `BackendId` type updated.
- **New adapter `src/agents/native-runtime.ts`** wraps
  `agentCommand()` from `openclaw/plugin-sdk/agent-runtime` so it satisfies
  the same `AcpBackend` interface automode already understands. The adapter:
  - Lazy-loads the SDK with the same multi-strategy loader as `telegram/sdk.ts`
    (bare specifier → file-URL import from every discovered openclaw root).
  - Manages `{sessionId, sessionKey}` per automode task so subsequent turns
    resume the same persisted transcript.
  - Converts the one-shot `Promise<{payloads, meta}>` return into the
    ACP-style `AsyncIterable` of `text_delta | done | error` events that
    `Dispatcher.runTurn()` yields.
  - Estimates per-turn cost from `meta.agentMeta.lastCallUsage` and emits
    it on the `done` event so the ledger + budget enforcement keep working.
  - Propagates an `AbortSignal` so `/automode stop` halts a running turn.
- **Discovery now scans both surfaces.** `discoverAcpxAgents()` was extended
  (kept the name for back-compat) to also read `agents.list[]` and tag each
  discovered id with its origin (`acpx` / `native`) via a new `originById`
  map. New `backendForAgent()` helper picks the right backend per id.
- **Per-agent backend auto-routing.** `Scheduler.startTask()` and
  `commands.ts::resolveTarget()` both check `cfg.agentOriginById[agent]`: if
  the chosen agent is native, the backend is auto-set to `openclaw-native`,
  even when the plugin's default `cfg.backend` says `claude-acp`. User
  can always override with `--backend=<id>`.
- **Dispatcher per-candidate routing.** `Dispatcher.ensure()` calls
  `resolveBackend(openclaw-native)` when the current fallback candidate is a
  native agent, `resolveBackend(backendId)` otherwise — so a mixed fallback
  chain (`[claude-bf, kimi]`) correctly hops from ACP → native mid-chain.

### Added — `/automode doctor` surfaces both registries
`/automode doctor` now shows:
```
Discovered acpx agents:   [claude, claude-bf, claude-vertex-opus47]
Discovered native agents: [main, coder, fast, critic]
```
`/automode init` snapshot includes the native list too. Boot-time log
prints both groups separately so you can tell at a glance which agents are
available on this host. If both are empty, the old error message is
updated to mention `agents.list[]` as the second remediation path.

### Added — Tests
- 9 new cases in `src/agents/discovery.test.ts` cover native extraction,
  acpx/native collision, malformed `agents.list`, `backendForAgent`.

### Changed — Type union widening
`BackendId` is now a named export in `types.ts` (was inlined in several
places as `"acpx" | "claude-acp"`). No runtime shape changes; no migration
needed for existing tasks — `TaskState.config.backend` remains the same
field, just with one more allowed value.

### Notes / limitations
- Native runtime is **one-shot per turn**: unlike ACP's streamed
  `text_delta`, the native backend emits a single `text_delta` (or none)
  followed by `done`. This matches the underlying `agentCommand()` surface
  — no mid-turn progress events. If you need true token-streaming, stick
  with ACP. Automode's progress display still edits the Telegram message on
  every `done`, so UX is equivalent for most workflows.
- **Cost estimation is approximate** — ~$0.002 / 1K input, ~$0.006 / 1K
  output blended rate. The runtime's own per-model pricing table isn't
  exposed; we under-estimate intentionally so budget caps don't over-fire.
- Model fallbacks (`agents.list[].model.fallbacks`) are handled transparently
  by the native runtime. Automode's `fallbackAgents` chain applies on top
  of that — if the whole native agent fails, automode can still fall back
  to a different agent altogether.

## [0.5.1] — 2026-04-21

### Fixed — Telegram menu actually works
- **Telegram SDK path**: 0.5.0 looked up `api.runtime.channel.telegram.sendMessageTelegram`
  which doesn't exist on the stock homebrew install; every notification
  (start / progress / done / escalation / verbose / menu) was a silent no-op.
  New `src/telegram/sdk.ts` multi-strategy loader tries bare-specifier imports
  first, then file-URL imports `dist/extensions/telegram/runtime-api.js` from
  every discovered openclaw install root. Falls back to a logged warning with
  every attempt listed if no SDK can be found.
- **Menu callback interception**: button taps arrive wrapped in OpenClaw's
  "Conversation info (untrusted metadata):…" envelope rather than as clean
  `content`. The `message_received` + `before_agent_start` hooks now regex
  `automode:menu:[A-Za-z0-9:_\\-]+` anywhere in the prompt, handle the action
  in `message_received` (sends the UI), and return a `·` systemPrompt ack in
  `before_agent_start` so the LLM doesn't hallucinate callback_data explanations.
- **chatId extraction** from hook context: OpenClaw doesn't surface `senderId`
  on hooks; the telegram target lives inside `sessionKey` as
  `agent:<id>:telegram:(direct|group):<chatId>`. New `extractHookChatId()`
  regex-matches that format with fallbacks for nested `from.id` and bare
  numeric chat ids.
- **Duplicate submenu** on tap: both hooks were sending the same submenu.
  `before_agent_start` now only produces the tiny `·` ack; `message_received`
  is the sole UI sender.

### Added — Tasks page with pagination, filters, live tail
- **📋 Tasks** button now opens a paginated task list (8 per page) with
  filter tabs: `Running N`, `All N`, `Done N`, `Failed N`. Empty tabs hide
  themselves (Running always shown). Active tab marked with `•`.
- **Task row** shows color-coded status glyph + short id + title + turn
  progress (live) or elapsed time (terminal) + cost: `🟢 tabc1234 — Fix Login
  Bug · t3/50 · $0.12`.
- **🔍 Task detail page**: tap a row → see goal, agent, autonomy, mode,
  status-glyph + turn/cost/elapsed, and action buttons that adapt to state:
  - Live: `[📡 Tail | 🔄 Refresh]` + `[⏸ Pause | ⏹ Stop]`
  - Paused: `[▶️ Resume | ⏹ Stop]`
  - Terminal: just `[‹ Back to tasks]`
- **📡 Tail** repurposes the task's `progressMessageId` to the current
  Telegram message, so subsequent turn-end progress updates edit *this*
  message live, with a `🛑 Stop tailing` button inline. No extra streaming
  infrastructure — reuses the existing progress edit path.
- **Pagination callbacks**: `automode:menu:nav:tasks:<filter>:<page>` with
  `‹ Prev | M/N | Next ›` navigation. Page counter is a `noop` callback so
  tapping it doesn't trigger a Telegram "nothing happened" toast.
- **Status glyphs** are now distinct per state: 🟢 running, 🔵 pending,
  🟡 waiting, ⏸️ paused, ⚠️ escalating, ✅ done, 🟠 capped, ❌ failed, ⛔ stopped.

### Added — Task titles
- `TaskState.title` is populated on creation from a heuristic clip of the
  goal (`heuristicTitle()`: first sentence, strips polite prefixes, collapses
  whitespace, clips to 60 chars).
- Planner turn 0 overwrites the heuristic with a cleaner 3–6 word Title
  Case version via new `title` field in the planner JSON output.
- Titles surface in the Tasks list, on the task detail page header, and
  are Markdown-escaped so user-controlled text can't break message parse.
- Older tasks without titles fall back to a clipped `goal`; no migration.

### Added — Menu buttons execute inline instead of hints
- Tapping **🧭 Doctor / 💡 Help / 🛠 Defaults / 🧩 Templates / 📖 Ledger**
  now runs the corresponding `/automode <subcmd>` via `runAutomodeCommand()`
  and streams the result back into the chat in a monospace fence. Previously
  these only nudged the user to type the slash command themselves.
- **New task** remains a hint (Telegram inline keyboards can't take text
  input, so the goal must be typed explicitly).
- Settlers set extended in `before_agent_start` so the LLM emits a `·` ack
  rather than hallucinating a response for these actions.

### Added — Built-in templates + full CRUD
- **14 built-in templates** ship with the plugin, covering dev + ops:
  `fix-tests`, `add-tests`, `review`, `refactor`, `bump-deps`, `debug`,
  `doc-sync`, `deploy-check`, `feature`, `bug-fix`, `api-endpoint`,
  `migrate`, `perf`, `spike`. Each has autonomy + maxTurns + maxCostUsd
  tuned to its risk profile. `/automode templates` marks them with ★;
  user-authored files (marked ·) override built-ins on name collision.
- `/automode template <name>` with no arg now **previews** the template
  (no run). Running still needs the `<arg>`.
- **New mutation commands**:
  - `/automode template-new <name>` — create empty user YAML
  - `/automode template-set <name> <field> <value>` — set one field
    (description, goal, goalTemplate, agent, backend, autonomy, verbosity,
    maxTurns, maxDurationSec, maxCostUsd, onDone, onFail)
  - `/automode template-clone <builtin> [new-name]` — copy a built-in for
    customisation (omit `new-name` to shadow)
  - `/automode template-delete <name>` — remove user YAML
- Built-ins are immutable: `template-set` / `template-delete` on a built-in
  name returns a clear error pointing at `template-clone`.
- Field values are validated + coerced (bad autonomy level, negative
  `maxTurns`, non-numeric `maxCostUsd` → clear error). Name validation:
  `^[a-z0-9][a-z0-9_-]{0,39}$`.
- **Telegram Templates menu** (🧩 Templates): lists user + built-in
  templates with `[➕ New] [✏️ Edit] [🗑 Delete] [📋 Clone]` buttons. Each
  button sends a hint explaining the slash command to type (buttons
  can't take text input).

### Polish
- DIAG hook logging is now gated behind `AUTOMODE_DEBUG=1` env (was
  always-on noise in 0.5.0).
- Tab labels in the Tasks filter row truncated on mobile Telegram at ~30
  chars; switched to two rows of two tabs with full labels
  (`• 🟢 Running 0` / `🗂 All 8` / `✅ Done 8` / `❌ Failed 1`).

## [0.5.0] — 2026-04-20

### Added — Telegram inline-keyboard menu
- **Typing `/automode` with no args in a Telegram chat now sends an
  interactive menu** instead of raw help text. The menu shows current
  agent, autonomy, budget, and verbosity in one line; running-task count;
  and a grid of buttons:
  - 🚀 New task · 📊 Tasks
  - 🎯 Autonomy · 💰 Budget · 🔊 Verbose (submenus — edit the message in place)
  - 📂 Templates · 📒 Ledger
  - 🩺 Doctor · ⚙️ Defaults · ❓ Help
- Submenu buttons (e.g. Autonomy → *strict/normal/high/yolo/super-yolo*,
  Budget → *$1/$5/$25/$100/off*, Verbose → *0/1/2/3*) mutate the sticky
  prefs and re-render the root menu in place so you see the new state
  without message spam.
- "New task" explains the one-liner to type; "Tasks", "Doctor", "Defaults",
  "Templates", "Ledger", "Help" each nudge you to the corresponding slash
  command for the richer CLI output.
- Non-Telegram channels fall back to the original text help.
- Namespace: menu callbacks are `automode:menu:<action>[:<arg>]`; the
  escalation callbacks (`automode:<taskId>:<escalationId>:<decision>`) are
  unchanged and handled by a separate branch in `/automode/cb`.

### Implementation
- New `src/telegram/menu.ts` with `buildMenu(page, scheduler, cfg, prefs)`
  returning `{ text, buttons }` and `parseMenuData(cb)` returning
  `{ kind, action, arg } | { kind, page } | null`. 13 unit tests.
- `index.ts` detects bare/menu invocations, sends the menu via
  `api.runtime.channel.telegram.sendMessageTelegram`, and dispatches
  callback taps through the existing `/automode/cb` HTTP route.
- `parseCallbackData` in `src/telegram/callbacks.ts` now returns `null`
  for the menu namespace so the two systems stay cleanly separated.

## [0.4.2] — 2026-04-20

### Fixed
- **CI pipeline end-to-end.** `.github/workflows/publish.yml` now uses
  `npm config set //registry.npmjs.org/:_authToken` to write the token
  literally into the runner's `.npmrc`. The previous setup relied on npm's
  `${VAR}` expansion inside `.npmrc` which wasn't picking up the
  `NODE_AUTH_TOKEN` env var setup-node wrote (ENEEDAUTH every time).
  This release is the **first to fully auto-publish from a git tag** —
  `git push origin vX.Y.Z` → npm within 30s.

## [0.4.1] — 2026-04-20

### Fixed
- **CI publish pipeline validated end-to-end.** First tag-triggered publish
  attempt on 0.4.0 failed because `setup-node` needed an explicit
  `scope: "@oc-moth"` for scoped-package auth to route through the
  generated `.npmrc`. Fix landed in `.github/workflows/publish.yml`; this
  release is the first to ship via a `git push --tags` alone.

### Docs
- README adds a "Web dashboard" section with the URL format, default port
  (`18789`), the 401 = live-route reading, and how to pass the gateway
  token via `curl` / the OpenClaw TUI.

## [0.4.0] — 2026-04-20

Five features in one release.

### Added — owner ACL
- **`strictOwner` config flag.** When true, only the user who started a task
  can stop/pause/resume it. Other callers still see the task via
  `/automode inspect`, `/automode tail`, `/automode logs`, and the web
  dashboard. Useful on shared gateways and group chats.
- `scheduler.stopTask|pauseTask|resumeTask` now return
  `{ ok: boolean; error?: string }` instead of plain `boolean` so the
  command surface can show the denial reason.

### Added — first-run wizard
- **`/automode init`.** Emits a ready-to-paste `plugins.entries.automode.config`
  block tailored to this host: picks the first discovered acpx agent, pins
  the computed chat id, pre-fills safe defaults. Also prints a sticky-setup
  cheat sheet (`/automode use …`, `/automode autonomy …`, etc.) and a
  validation command. Eliminates the "no acpx agents discovered" and bogus
  chatId footguns on brand-new installs.

### Added — live progress dashboard (Telegram)
- The per-turn edit-in-place progress message is now richer:
  ```
  🔄 automode \`t…\` · turn 5/50
  codex @ acpx · cost $0.1612 · elapsed 2m 10s · ETA ~18m
  …summary…
  ```
- ETA is computed from observed average turn duration × remaining turns,
  clamped by the task's `maxDurationSec` cap. No extra notifications — the
  dashboard is always an edit of the original progress message.

### Added — default-to-automode
- Three layers in priority order, **flags → per-chat prefs → plugin config**:
  - **Per-chat toggle:** `/automode on` enables routing for THIS chat;
    `/automode off` disables. Stored in `Preferences.chatDefaults` keyed by
    the resolved chat id.
  - **Heuristic gate:** `defaultMode.gate` = `any` | `verb` | `length` |
    `verbOrLength` (default). `verb` requires a known action-verb prefix
    (configurable list); `length` requires ≥ `minWords` words.
  - **Host-wide default:** `defaultMode.enabled` in plugin config.
- Implementation uses OpenClaw's `before_agent_start` hook (that's the only
  pre-agent hook that can mutate behaviour). When routing fires, a task
  spawns in the background and the normal agent is steered (via
  `systemPrompt` override) to respond with a one-line
  "🤖 Routed to automode task \`t…\`" acknowledgement.

### Added — web dashboard
- **`GET /automode/ui`** serves a single-file HTML page (no JS framework, no
  external assets). Shows running/done/failed counts, total cost, and a
  table of the 200 most recent tasks with status, autonomy, agent@backend,
  turns, cost, owner, age, and goal. Auto-refreshes every 5s.
- Auth: `gateway` (uses the normal gateway token so the page is only
  accessible to authorised callers).

### Changed
- `Preferences` gains `chatDefaults: Record<chatId, boolean>` for the
  per-chat toggle.
- `AutomodeConfig` gains `strictOwner` and `defaultMode` (all with safe
  defaults — existing configs keep today's behaviour).

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
