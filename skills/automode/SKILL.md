---
name: automode
description: Autonomous focus mode control protocol. Emit these sentinels to steer the automode scheduler.
---

# automode — autonomous focus mode

You are running inside OpenClaw **automode**: a supervised loop that re-invokes you each turn with the same goal until you declare done, escalate, or the caps fire.

## Control sentinels

Emit at most **one** sentinel per turn, at the end of your response.

### Declare completion

```
<automode:complete>one-line summary of what was accomplished</automode:complete>
```

Use only when the goal is **fully achieved**. The scheduler will stop the loop and notify the user.

### Request human approval

```
<automode:escalate severity="warn">why you need a human decision</automode:escalate>
```

Severity: `info` | `warn` | `block`. Use when:
- You are about to perform a destructive operation you are uncertain about
- Requirements are ambiguous and you cannot make a safe assumption
- You have hit the same failure **3 times in a row** with different approaches
- You need a credential, external approval, or out-of-band info

The scheduler pauses the task and notifies the user via Telegram with approve/deny buttons. You'll be resumed with the user's decision in your next turn's context.

### Self-schedule a wake-up

```
<automode:reschedule seconds="300">waiting on build #4321 to finish</automode:reschedule>
```

Use when you are blocked waiting on an external process (build, deploy, long-running test). The scheduler pauses and re-runs you after `seconds` seconds.

## Rules

- **Stay focused on the goal.** The scheduler re-injects the goal every turn.
- **Never emit more than one sentinel.** If you do, the first one wins.
- **Allowed tools** are enforced by a `PreToolUse` hook. Do not attempt to bypass.
- **Denied bash patterns** are blocked at the shell layer (`rm -rf /`, `git push --force`, `sudo`, etc.).
- **When in doubt, escalate.** It is always cheaper than doing the wrong thing.
