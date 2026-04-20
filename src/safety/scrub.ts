/**
 * Redact common secret formats from any string that's about to be persisted
 * or streamed to a third party (Telegram, log files, audit JSONL).
 *
 * Deliberately conservative — we prefer a false positive (scrubbing something
 * innocuous) over a false negative (leaking a real token). Extend the patterns
 * carefully with test coverage.
 */
export type Scrubber = (input: string) => string;

type Rule = {
  name: string;
  re: RegExp;
  replace: string | ((...args: string[]) => string);
};

const RULES: readonly Rule[] = [
  { name: "anthropic-api", re: /sk-ant-(?:api|admin)?-?[A-Za-z0-9_-]{20,}/g, replace: "sk-ant-REDACTED" },
  { name: "openai-api", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, replace: "sk-REDACTED" },
  { name: "openai-project", re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, replace: "sk-proj-REDACTED" },
  { name: "github-pat-classic", re: /\bghp_[A-Za-z0-9]{30,}\b/g, replace: "ghp_REDACTED" },
  { name: "github-oauth", re: /\bgho_[A-Za-z0-9]{30,}\b/g, replace: "gho_REDACTED" },
  { name: "github-app-user", re: /\bghu_[A-Za-z0-9]{30,}\b/g, replace: "ghu_REDACTED" },
  { name: "github-app-server", re: /\bghs_[A-Za-z0-9]{30,}\b/g, replace: "ghs_REDACTED" },
  { name: "github-refresh", re: /\bghr_[A-Za-z0-9]{30,}\b/g, replace: "ghr_REDACTED" },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}\b/g, replace: "npm_REDACTED" },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "AKIA_REDACTED" },
  { name: "aws-session-token", re: /\b(?:ASIA|FQoG)[0-9A-Z]{16,}\b/g, replace: "AWS_SESSION_REDACTED" },
  { name: "slack-bot", re: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, replace: "xox_REDACTED" },
  { name: "gcp-api", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replace: "AIza_REDACTED" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: "<JWT>" },
  {
    name: "bearer",
    re: /\b(?:[Bb]earer)\s+([A-Za-z0-9_.\-=+/]{20,})/g,
    replace: (_m, _token) => "Bearer <REDACTED>",
  },
  {
    name: "kv-style",
    re: /\b(token|api[_-]?key|apikey|password|secret|passwd)\s*[:=]\s*["']?([A-Za-z0-9_\-+/=]{16,})["']?/gi,
    replace: (_m, label) => `${label}=<REDACTED>`,
  },
];

export const scrub: Scrubber = (input: string): string => {
  if (!input || typeof input !== "string") return input;
  let out = input;
  for (const rule of RULES) {
    out = out.replace(rule.re, rule.replace as never);
  }
  return out;
};

/** Apply scrub to every string leaf in a JSON-ish value. */
export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrub(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Cap a string at `max` chars and annotate the omitted length. */
export function truncate(input: string, max: number): string {
  if (!input) return input;
  if (input.length <= max) return input;
  return input.slice(0, max) + `…+${input.length - max}`;
}

/** Rule names for diagnostics / tests. */
export const scrubRuleNames = RULES.map((r) => r.name);
