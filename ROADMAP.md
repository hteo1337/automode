# automode — roadmap

> Prioritized follow-ups to the gaps in `AUDIT.md`. Grouped by release
> candidate and tagged by impact / effort. No dates — merged as they land.

Legend: **I** impact (🔴 high / 🟡 medium / 🟢 low) · **E** effort (S / M / L)

---

## v0.2 — safety hardening & real observability ✅ shipped in 0.2.0

| Item | Status | Notes |
| --- | :-: | --- |
| Path-scope enforcement for `Edit` / `Write` / `Bash cd` | ✅ 0.2.0 | `PreToolUse` hook embeds `SCOPE_ROOTS` + `WRITE_TOOLS`; blocks escapes. |
| Secret scrubbing in turn audit | ✅ 0.2.0 | `src/safety/scrub.ts` — 14 rules. |
| Cost tracking (USD) | ✅ 0.2.0 | Snapshot from `getStatus().details.cost`; `maxCostUsd` cap. |
| Token / context budgeting | 🟡 → v0.3 | Cost proxies this; explicit token counting still pending. |
| OTel metrics export | ❌ → v0.3 | Deferred. |
| Structured audit export | ✅ 0.2.0 | `inspect --json`, `tail --json`. |
| Tool argument truncation | ✅ 0.2.0 | `auditArgMaxChars` default 2000. |
| Denylist hardening | ✅ 0.2.0 | `HARDCODED_DENY_PATTERNS` on top of user regex list. |
| **Bonus:** autonomy levels (strict/normal/high/yolo) | ✅ 0.2.0 | Response to the "task paused for approval" failure mode. |
| **Bonus:** owner tagging | ✅ 0.2.0 | Captured from `CommandCtx`; read-only display for now. |
| **Bonus:** exponential backoff between fallback attempts | ✅ 0.2.0 | 500ms × 2^N, capped 10s. |
| **Bonus:** boot-time config validation | ✅ 0.2.0 | Warns on unreachable defaultAgent / empty fallbacks. |

## v0.3 — multi-channel + shareable tasks + observability polish

Pulled in from deferred v0.2 work:
- **Token / context budgeting** with soft/hard thresholds.
- **OTel metrics export** via the `diagnostics-otel` SDK.
- **Layer 2 turn cancellation** — `before_tool_call` hook calls
  `runtime.cancel()` when it sees a denylisted tool event (belt-and-braces
  over Layer 1).


| Item | I | E | Notes |
| --- | :-: | :-: | --- |
| Streaming to the invoking channel regardless of type | 🔴 | M | Abstract `notifier` beyond Telegram; support Slack / Discord / Matrix via `api.runtime.channel.<name>.sendText`. |
| Owner tag on tasks | 🔴 | S | `TaskState.owner: { channel, accountId, senderId }`. Non-owners see read-only info via `inspect`. |
| Task templates | 🟡 | S | `~/.openclaw/automode/templates/*.yaml` — load presets like `refactor`, `fix-tests`, `ship-pr`. |
| Task chaining | 🟡 | M | `then:` field in template; on-done dispatches the next task with context. |
| `/automode watch <id>` live stream | 🟡 | M | Register current channel as a per-task stream destination (in-memory, TTL). |

## v0.4 — planner upgrades

| Item | I | E | Notes |
| --- | :-: | :-: | --- |
| Structured subtask dependencies | 🟡 | M | Coordinator turn respects `dependsOn` DAG rather than firing all workers each turn. |
| Per-subtask caps (turns + time) | 🟡 | S | Subtasks get their own caps; a worker can cap-out without killing the parent. |
| Dynamic worker spawn (`automode.spawn`) | 🟡 | L | Agent emits a sentinel → scheduler spawns a sub-ACP session with a child goal. |
| Planner quality metric | 🟢 | M | Track (done / escalated / failed) by planner confidence bucket; tune `planFirstThreshold` from data. |

## v0.5 — operator ergonomics

| Item | I | E | Notes |
| --- | :-: | :-: | --- |
| First-run wizard | 🟡 | S | `/automode init` — interactive config: picks defaults, pins chatId, writes config. |
| RPC + minimal web dashboard | 🟢 | L | `automode.list`, `automode.get(id)`, `automode.stream(id)`; plus a single-page HTML served on `/automode/ui`. |
| ESLint + Prettier config | 🟢 | S | Ship linting with the repo; enforce in CI. |
| SBOM + signed releases | 🟢 | M | `npm publish --provenance` (already wired) + GitHub-attested SBOM. |

## v1.0 — stable API

| Item | I | E | Notes |
| --- | :-: | :-: | --- |
| Freeze `TaskState` schema (with migration fn) | 🔴 | M | Add `state.version`, provide 0.x → 1.x upgrader. |
| Public tool signatures in a separate `@oc-moth/automode-sdk` | 🟡 | M | Consumers can build extensions / UIs without reaching into internals. |
| Breaking-change policy | 🟡 | S | Document deprecation window; keep `*.deprecated` exports for 2 minor releases. |
| e2e harness (`vitest` + mock ACP) | 🔴 | L | Real turn loop against a scripted backend; catches regressions the unit tests miss. |

---

## Deferred / research

- **Mobile approvals** — Telegram Web App mini-cards for richer approve flows.
- **Cross-host task sync** — two gateways on different machines coordinating a single task (shared state over CRDT or Git).
- **LLM-based denylist expansion** — a judge model flags suspicious bash even when regex passes.
- **Live cost ledger** — all tasks aggregated into a daily / monthly spend view.
- **Agent A/B testing** — run the same task on two agents in shadow mode; compare outputs before committing side effects.

---

## How to contribute a feature

1. Find the row above (or add it as a PR in `ROADMAP.md` first).
2. Open an issue or PR referencing the row.
3. Include a test demonstrating the gap is closed.
4. Update `AUDIT.md` to flip the status emoji.
5. Bump `CHANGELOG.md` under the appropriate release header.
