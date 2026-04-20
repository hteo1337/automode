export type EscalateArgs = {
  reason: string;
  severity: "info" | "warn" | "block";
};

export const escalateToolName = "automode.escalate";

const TAG_RE = /<automode:escalate(?:\s+severity=["'](info|warn|block)["'])?\s*>([\s\S]*?)<\/automode:escalate>/i;
const LINE_RE = /(?:^|\n)\s*AUTOMODE[_:\s]ESCALATE\s*[:=]\s*(?:(info|warn|block)\s*[|:]\s*)?([^\n]+)/i;
const TOOL_RE = /automode\.escalate\s*\(\s*(?:reason\s*[:=]\s*)?["']([^"']+)["'](?:\s*,\s*(?:severity\s*[:=]\s*)?["'](info|warn|block)["'])?\s*\)/i;

function norm(sev: string | undefined): "info" | "warn" | "block" {
  return sev === "info" || sev === "warn" || sev === "block" ? sev : "warn";
}

export function detectEscalate(text: string): EscalateArgs | null {
  if (!text) return null;
  const tag = text.match(TAG_RE);
  if (tag) return { severity: norm(tag[1]), reason: (tag[2] ?? "").trim().slice(0, 500) };
  const line = text.match(LINE_RE);
  if (line) return { severity: norm(line[1]), reason: (line[2] ?? "").trim().slice(0, 500) };
  const tool = text.match(TOOL_RE);
  if (tool) return { severity: norm(tool[2]), reason: (tool[1] ?? "").trim().slice(0, 500) };
  return null;
}

export function detectEscalateCall(text: string): EscalateArgs | null {
  return detectEscalate(text);
}
