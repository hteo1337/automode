export type AllowlistDecision = {
  allowed: boolean;
  reason?: string;
  matched?: string;
};

export type AllowlistOptions = {
  allowedTools: string[];
  deniedBashPatterns: string[];
};

const BASH_TOOL_NAMES = new Set(["Bash", "bash", "Shell", "shell"]);

export function parseToolCallText(raw: string): { name: string; command?: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { name: "" };
  const firstLine = trimmed.split("\n")[0] ?? "";
  const match = firstLine.match(/^\s*(?:tool:\s*)?([A-Za-z_][\w.-]*)/);
  const name = match?.[1] ?? firstLine;
  const cmdMatch = trimmed.match(/(?:command|bash|cmd)\s*[:=]\s*([\s\S]+)$/i);
  const command = cmdMatch?.[1]?.trim();
  return { name, command };
}

/**
 * Hardened patterns always checked in addition to the user's denylist. These
 * target obfuscation techniques that bypass naive string matches.
 */
export const HARDCODED_DENY_PATTERNS: readonly RegExp[] = [
  /\beval\s+["']?[^"'\n]*\$\(/,                 // eval "...$(...)"
  /`[^`]{10,}`\s*\|\s*(?:bash|sh|zsh)\b/,       // `...` | sh
  /\bbase64\s+(?:-d|--decode)\b[^|\n]*\|\s*(?:bash|sh|zsh)/,
  /\bcurl\b[^|\n]*\|\s*xargs\s+(?:-0\s+)?(?:bash|sh)/,
  /\bwget\b[^|\n]*\|\s*(?:bash|sh|zsh)\b/,
  /\bpython3?\s+-c\s+["']?[^"'\n]*__import__\(["']os["']\)/,
  /\bperl\s+-e\s+["']?[^"'\n]*system\(/,
  /\becho\s+["']?[A-Za-z0-9+/=]{40,}["']?\s*\|\s*base64\s+-d\s*\|\s*(?:bash|sh)/,
  /\bIFS\s*=\s*['"]?\$?[^'"\s]+['"]?\s*;\s*(?:\$|\b(?:exec|eval))/,
];

export function decide(
  toolNameRaw: string,
  commandText: string | undefined,
  opts: AllowlistOptions,
): AllowlistDecision {
  const toolName = (toolNameRaw ?? "").trim();
  if (!toolName) {
    return { allowed: false, reason: "empty tool name" };
  }
  const allowed = opts.allowedTools.some(
    (t) => t === toolName || t.toLowerCase() === toolName.toLowerCase(),
  );
  if (!allowed) {
    return { allowed: false, reason: `tool '${toolName}' not in allowlist` };
  }
  if (BASH_TOOL_NAMES.has(toolName) && commandText) {
    for (const hard of HARDCODED_DENY_PATTERNS) {
      if (hard.test(commandText)) {
        return {
          allowed: false,
          reason: "bash command matches built-in obfuscation guard",
          matched: hard.source,
        };
      }
    }
    for (const pat of opts.deniedBashPatterns) {
      try {
        const re = new RegExp(pat);
        if (re.test(commandText)) {
          return {
            allowed: false,
            reason: `bash command matches denied pattern`,
            matched: pat,
          };
        }
      } catch {
        // ignore bad patterns
      }
    }
  }
  return { allowed: true };
}
