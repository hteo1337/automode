export type RescheduleArgs = {
  delaySec: number;
  note?: string;
};

export const rescheduleToolName = "automode.reschedule";

const TAG_RE = /<automode:reschedule(?:\s+seconds=["'](\d+(?:\.\d+)?)["'])?\s*>([\s\S]*?)<\/automode:reschedule>/i;
const LINE_RE = /(?:^|\n)\s*AUTOMODE[_:\s]RESCHEDULE\s*[:=]\s*(\d+(?:\.\d+)?)(?:\s*[|:]\s*([^\n]+))?/i;
const TOOL_RE = /automode\.reschedule\s*\(\s*(?:delay(?:Sec)?\s*[:=]\s*)?(\d+(?:\.\d+)?)(?:\s*,\s*(?:note\s*[:=]\s*)?["']([^"']+)["'])?\s*\)/i;

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 60;
  return Math.min(86400, Math.max(1, Math.floor(n)));
}

export function detectReschedule(text: string): RescheduleArgs | null {
  if (!text) return null;
  const tag = text.match(TAG_RE);
  if (tag) {
    return { delaySec: clamp(Number(tag[1] ?? 60)), note: (tag[2] ?? "").trim().slice(0, 300) || undefined };
  }
  const line = text.match(LINE_RE);
  if (line) {
    return { delaySec: clamp(Number(line[1] ?? 60)), note: line[2]?.trim().slice(0, 300) };
  }
  const tool = text.match(TOOL_RE);
  if (tool) {
    return { delaySec: clamp(Number(tool[1] ?? 60)), note: tool[2]?.trim().slice(0, 300) };
  }
  return null;
}

export function detectRescheduleCall(text: string): RescheduleArgs | null {
  return detectReschedule(text);
}
