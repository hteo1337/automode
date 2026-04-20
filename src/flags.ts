/**
 * Lightweight flag parser for `/automode` arguments. Supports:
 *   --agent=<id>    or  -a=<id>    or  --agent <id>    or  -a <id>
 *   --backend=<id>  or  -b=<id>    or  --backend <id>  or  -b <id>
 *   --plan                                              (sets planFirst)
 *   --turns=<n>                                         (maxTurns)
 *   --mins=<n>                                          (maxDurationSec = n*60)
 *
 * Everything unclaimed becomes the goal text.
 */
export type ParsedFlags = {
  agent?: string;
  backend?: string;
  plan?: boolean;
  maxTurns?: number;
  maxDurationSec?: number;
  verbosity?: 0 | 1 | 2 | 3;
  autonomy?: "strict" | "normal" | "high" | "yolo" | "super-yolo";
  dryRun?: boolean;
  budgetUsd?: number;
  onDone?: string;
  onFail?: string;
  rest: string;
};

const KNOWN_BACKENDS = new Set(["acpx", "claude-acp"]);

export function parseFlags(raw: string): ParsedFlags {
  const out: ParsedFlags = { rest: "" };
  const tokens = raw.split(/\s+/).filter(Boolean);
  const leftover: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    // --key=value and -k=value
    const eq = t.match(/^(--?[a-zA-Z][\w-]*)=(.*)$/);
    if (eq) {
      applyFlag(eq[1]!, eq[2]!, out);
      continue;
    }

    // -v / -vv / -vvv shorthand for --verbose=N
    const v = t.match(/^-v{1,3}$/);
    if (v) {
      out.verbosity = clampVerbosity(t.length - 1);
      continue;
    }
    // --yolo shorthand for --autonomy=yolo; -y also works.
    if (t === "--yolo" || t === "-y") {
      out.autonomy = "yolo";
      continue;
    }
    // --super-yolo / --unsafe / --no-guards / -yy: disable tool rails.
    if (
      t === "--super-yolo" || t === "--superyolo" ||
      t === "--unsafe" || t === "--no-guards" || t === "--no-guard" ||
      t === "-yy"
    ) {
      out.autonomy = "super-yolo";
      continue;
    }
    // --dry-run or --dry or -n: simulate without actually executing.
    if (t === "--dry-run" || t === "--dry" || t === "-n") {
      out.dryRun = true;
      continue;
    }
    // --key value and -k value (only for flags that take a value)
    if (t.startsWith("-")) {
      if (takesValue(t) && i + 1 < tokens.length && !tokens[i + 1]!.startsWith("-")) {
        applyFlag(t, tokens[i + 1]!, out);
        i++;
        continue;
      }
      // boolean switch
      applyFlag(t, "true", out);
      continue;
    }

    leftover.push(t);
  }

  out.rest = leftover.join(" ");
  if (out.backend && !KNOWN_BACKENDS.has(out.backend)) {
    // Keep it but caller validates.
  }
  return out;
}

function takesValue(token: string): boolean {
  return [
    "--agent", "-a",
    "--backend", "-b",
    "--turns", "--mins",
    "--verbose", "--verbosity",
    "--autonomy",
    "--budget",
    "--on-done", "--on-fail",
  ].includes(token);
}

function normAutonomy(
  v: string,
): "strict" | "normal" | "high" | "yolo" | "super-yolo" | undefined {
  const n = v.toLowerCase().trim();
  if (
    n === "super-yolo" || n === "superyolo" ||
    n === "unsafe" || n === "no-guard" || n === "no-guards" || n === "bypass"
  ) return "super-yolo";
  if (n === "yolo" || n === "full-yolo" || n === "auto-approve") return "yolo";
  if (n === "high" || n === "fast") return "high";
  if (n === "normal" || n === "default" || n === "balanced") return "normal";
  if (n === "strict" || n === "careful" || n === "paranoid") return "strict";
  return undefined;
}

function clampVerbosity(n: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(n)) return 1;
  const i = Math.max(0, Math.min(3, Math.floor(n)));
  return i as 0 | 1 | 2 | 3;
}

function applyFlag(key: string, value: string, out: ParsedFlags): void {
  switch (key) {
    case "--agent":
    case "-a":
      out.agent = value;
      break;
    case "--backend":
    case "-b":
      out.backend = value;
      break;
    case "--plan":
      out.plan = /^(?:1|true|yes|on)?$/i.test(value);
      break;
    case "--turns": {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.maxTurns = Math.floor(n);
      break;
    }
    case "--mins": {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.maxDurationSec = Math.floor(n * 60);
      break;
    }
    case "--verbose":
    case "--verbosity": {
      out.verbosity = clampVerbosity(Number(value));
      break;
    }
    case "--autonomy": {
      const a = normAutonomy(value);
      if (a) out.autonomy = a;
      break;
    }
    case "--budget": {
      const n = Number(String(value).replace(/^\$/, ""));
      if (Number.isFinite(n) && n >= 0) out.budgetUsd = n;
      break;
    }
    case "--on-done":
      out.onDone = value;
      break;
    case "--on-fail":
      out.onFail = value;
      break;
    default:
      // unknown flag — ignore silently; the arg won't match any goal
      break;
  }
}
