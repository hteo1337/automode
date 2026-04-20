import fs from "node:fs";
import path from "node:path";

export type AgentEntry = {
  id: string;
  name: string;
  description: string;
  source: string;
};

function readFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const body = text.slice(3, end);
  const result: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (m) result[m[1]!.toLowerCase()] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return result;
}

export function scanAgentDir(dir: string): AgentEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: AgentEntry[] = [];
  const walk = (d: string) => {
    let items: string[];
    try {
      items = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const name of items) {
      const full = path.join(d, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && name.toLowerCase().endsWith(".md")) {
        try {
          const raw = fs.readFileSync(full, "utf8");
          const fm = readFrontmatter(raw);
          const id = fm.name || path.basename(name, ".md");
          entries.push({
            id,
            name: fm.name || id,
            description: fm.description ?? "",
            source: full,
          });
        } catch {
          // skip
        }
      }
    }
  };
  walk(dir);
  return entries;
}

export function scanAgentPaths(paths: string[]): AgentEntry[] {
  const seen = new Set<string>();
  const out: AgentEntry[] = [];
  for (const p of paths) {
    for (const ent of scanAgentDir(p)) {
      if (seen.has(ent.id)) continue;
      seen.add(ent.id);
      out.push(ent);
    }
  }
  return out;
}
