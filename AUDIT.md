# automode — code & feature audit

> As of v0.2.0 · 2026-04-20 · scope: `src/**` and published tarball.

This document scores what exists today, what's rough, and what's missing.
The goal is to make the trade-offs explicit and keep v0.x honest.

---

## 1. Build, tooling, release

| Area | Status | Notes |
| --- | :-: | --- |
| TypeScript strict mode | ✅ | `strict: true`, no `any` leaks in source. |
| Test coverage | 🟡 | 114 tests cover unit modules; **no integration tests** against a real ACP runtime or Telegram — scheduler end-to-end is unverified. |
| CI | ✅ | GitHub Actions workflow templates exist for test + publish. |
| npm publish | ✅ | Live on `@oc-moth/automode`. Provenance CI path defined but requires token rotation + GitHub repo. |
| Semver discipline | 🟡 | 0.x with frequent minor bumps; `0.1.2` was a version-sync fix — avoid recurrence by running `prepublishOnly` checks. |
| Linting | ❌ | No ESLint config shipped. Relying on tsc strict + reviewer eye. |
| Changelog | ✅ | Keep-a-Changelog format maintained. |

## 2. Plugin surface

| Surface | Status | Notes |
| --- | :-: | --- |
| Manifest (`openclaw.plugin.json`) | ✅ | JSON Schema + `uiHints`. |
| Slash command `/automode` | ✅ | 20+ subcommands + flag parser. |
| CLI (`openclaw automode …`) | 🟡 | Exists but only covers `list|start|stop|inspect`; not in sync with slash surface. |
| Gateway RPC | ❌ | No `automode.*` RPCs registered — would enable external dashboards. |
| HTTP route `/automode/cb` | 🟡 | Handles Telegram button callback_data parsing; not exercised by real tests. |
| Lifecycle service | ✅ | Start/stop wired; crash-resume scans disk. |

## 3. Execution engine

| Concern | Status | Notes |
| --- | :-: | --- |
| Four modes (goal/interval/paced/hybrid) | ✅ | Single state machine; covered by unit tests. |
| Turn cap + time cap | ✅ | Supervisor enforces both. |
| Done detection (3 sentinel forms) | ✅ | XML tag, sentinel line, tool-call style — all matched. |
| Escalation flow | 🟡 | State transitions tested; Telegram callback round-trip **not** covered by tests. |
| Self-reschedule | ✅ | `<automode:reschedule seconds=…>`. |
| Consecutive-failure guard | 🟡 | Supervisor logic returns "continue" after one error, "failed" after 3 — but streak tracking across reloads is implicit (reads from turn record, not persisted counter). Possible gap if gateway restarts mid-streak. |
| Resumable after crash | ✅ | `TaskStore.listRunning()` + `scheduler.start()`. Unit-tested via state round-trip; full end-to-end resume **not** tested. |

## 4. Multi-agent + fallback

| Feature | Status | Notes |
| --- | :-: | --- |
| `defaultAgent: "auto"` + discovery | ✅ | Reads `plugins.entries.acpx.config.agents`. |
| `fallbackAgents` ordered chain | ✅ | `buildAgentChain` dedupes across sources. |
| Retry-class policy | ✅ | Rate-limit, 5xx, timeout, network, not-found. |
| Health probe (`getStatus`) | ✅ | Gated behind `healthProbeEnabled`. |
| Planner role → agent mapping | ✅ | `agentRoleMap` supports `auto`. |
| Parallel worker pool | 🟡 | Implemented; coordinator merge is minimal (no cross-worker dependency resolution, no deadline redistribution). |
| Subtask status tracking | 🟡 | Per-subtask `status` exists; no per-subtask caps, escalations, or telemetry. |
| Dynamic worker spawn | ❌ | `automode.spawn` tool is in SKILL.md but not implemented. |

## 5. Safety

| Layer | Status | Notes |
| --- | :-: | --- |
| Layer 1: per-task `PreToolUse` hook | ✅ | Generated wrapper + hook; enforces allowlist + denylist + path scope. |
| Layer 2: `before_tool_call` observer | 🟡 | Logs + audit append; does **not** cancel the turn today (roadmap'd). |
| Default allowlist | ✅ | Sensible (Read, Grep, Glob, Edit, Write, Bash…). |
| Default denylist | ✅ | Covers `rm -rf /`, force-push, sudo, curl-pipe-sh, mkfs, dd. |
| Bash denylist enforcement | ✅ | User regex + built-in `HARDCODED_DENY_PATTERNS` (eval+$(…), base64-to-sh, wget\|sh, python/perl shell-out). |
| Write path scoping | ✅ | Layer 1 `PreToolUse` now blocks `Edit`/`Write`/`NotebookEdit` outside `task.cwd ∪ task.scope.paths`; also checks absolute `cd` targets. |
| Secrets scrubbing in logs | ✅ | 14-rule scrubber applied to prompts, tool args, events, errors, output, thoughts before JSONL write. |
| Tool argument caps | ✅ | `auditArgMaxChars` default 2000 with `…+NNN` marker. |

## 6. Observability

| Feature | Status | Notes |
| --- | :-: | --- |
| Telegram progress updates | ✅ | Start / edit-in-place / escalation / done (with cost). |
| Verbosity levels (0–3) | ✅ | 0.1.5 shipped. |
| `/automode tail` | ✅ | 0.1.5; `--json` in 0.2.0. |
| Live stream over any channel | 🟡 | Telegram only. Slack / Discord / Matrix not wired. |
| Cost tracking (USD) | ✅ | Snapshotted from `runtime.getStatus().details.cost` after each turn; `maxCostUsd` cap. |
| Token / context budgeting | 🟡 | Cost proxies it today; explicit token counting deferred to v0.3. |
| Metrics export (Prometheus/OTel) | ❌ | Nothing exposed to `diagnostics-otel`. |
| Structured audit export | ✅ | `/automode inspect <id> --json` and `/automode tail <id> --json`. |

## 7. UX / ergonomics

| Feature | Status | Notes |
| --- | :-: | --- |
| `/automode doctor` diagnostic | ✅ | SDK + roots + discovered agents + prefs. |
| Sticky prefs via `/automode use` | ✅ | 0.1.4 shipped. |
| Help text | ✅ | Reasonably complete; could group by lifecycle. |
| Error messages | 🟡 | Most are actionable; a few throw generic `Error` without codes. |
| Interactive setup | ❌ | No first-run wizard; relies on the user reading README. |
| Task templates / recipes | ❌ | Would be useful for repeatable workflows. |
| Task chaining (A then B) | ❌ | Manual via sentinel in goal; no first-class construct. |

## 8. Security posture

| Concern | Status | Notes |
| --- | :-: | --- |
| Secret handling | ✅ | No tokens stored by the plugin; prefs file mode `0600`. |
| Dependency surface | ✅ | Single runtime dep: `uuid`. |
| Supply chain | 🟡 | npm publish with provenance planned; no SBOM / signed commits. |
| Prompt injection posture | 🟡 | Goal prompt is user-supplied; agent can be nudged into tool calls the user didn't ask for. Allowlist helps, denylist helps; *no* output sanitization. |
| Path traversal | ❌ | No check that the agent stays inside `task.cwd` / `scope.paths`. |
| Shell variable interpolation in denylist | 🟡 | Regex tested against pre-expansion command string; post-expansion behavior depends on the shell. |

## 9. Failure modes we know about

1. **Agent chain exhausted** (all retryable) → task fails. No cool-down or circuit-breaker; next `/automode` immediately re-tries the same chain.
2. **Telegram plugin disappears mid-task** → notifier silently drops updates; task continues. No retry buffer.
3. **`acpx` backend not registered at gateway boot** → first task fails with clear message, subsequent tasks do too. Doctor surfaces the cause.
4. **Planner returns non-JSON** → fallback to single-agent. OK, but confidence is hard-coded to 0.3.
5. **State file corrupted** → load returns `null`, task is invisible. No recovery / backup.
6. **Schema mismatch after upgrade** → config fields added in 0.1.5 (verbosity) crash strict-mode config validators on 0.1.0 consumers? No — schema changes are additive with defaults, so downgrade is lossy but not broken.

## 10. Things "too magical" that deserve doc or caveat

- **"auto" expands to all discovered agents** — if you have 8 acpx agents configured, your fallback chain is 8 deep by default. Users may want a visibility warning.
- **Smart backend inference** routes `claude*` to `claude-acp`. If your `claude-acp` plugin isn't loaded, this silently 404s and we fall through retries. Should doctor flag this.
- **`<automode:complete>` sentinel parser is permissive** — an agent mentioning the tag in documentation could accidentally end a task.
- **No "owner" field on tasks** — in a multi-user OpenClaw instance (shared gateway), any authorized user can stop any task.

---

See `ROADMAP.md` for the prioritized response to these gaps.
