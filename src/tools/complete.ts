/**
 * Agent-facing control sentinel: <automode:complete>summary</automode:complete>
 * The agent emits this tag when the goal is reached. The runner scans the
 * accumulated turn output for it.
 */
export type CompleteArgs = { summary: string };

export const completeToolName = "automode.complete";

const TAG_RE = /<automode:complete>([\s\S]*?)<\/automode:complete>/i;
const LINE_RE = /(?:^|\n)\s*AUTOMODE[_:\s]COMPLETE\s*[:=]\s*([^\n]+)/i;
const TOOL_RE = /automode\.complete\s*\(\s*(?:summary\s*[:=]\s*)?["']([\s\S]*?)["']\s*\)/i;

export function detectComplete(text: string): CompleteArgs | null {
  if (!text) return null;
  const tag = text.match(TAG_RE);
  if (tag?.[1] !== undefined) return { summary: tag[1].trim().slice(0, 2000) };
  const line = text.match(LINE_RE);
  if (line?.[1] !== undefined) return { summary: line[1].trim().slice(0, 2000) };
  const tool = text.match(TOOL_RE);
  if (tool?.[1] !== undefined) return { summary: tool[1].trim().slice(0, 2000) };
  return null;
}

/** Legacy alias retained for internal detection from tool_call events. */
export function detectCompleteCall(text: string): CompleteArgs | null {
  return detectComplete(text);
}
