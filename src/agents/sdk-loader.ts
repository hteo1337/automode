import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type SdkImportError = {
  strategy: string;
  message: string;
};

export type SdkImportResult = {
  module: unknown;
  strategy: string;
  resolvedFrom: string;
};

/**
 * Locate OpenClaw's installation directory. Plugin extensions live under
 * `~/.openclaw/extensions/` and don't have `openclaw` in their own
 * `node_modules`, so Node's default resolution of bare specifiers like
 * `openclaw/plugin-sdk/acp-runtime` often fails. This helper probes every
 * sensible candidate.
 */
export function findOpenclawRoots(): string[] {
  const roots = new Set<string>();

  // 1. Derived from argv[1] (the gateway entry) — walk up to node_modules/openclaw
  const entry = process.argv[1];
  if (entry) {
    let dir = path.resolve(path.dirname(entry));
    const seen = new Set<string>();
    while (!seen.has(dir) && dir.length > 1) {
      seen.add(dir);
      const cand = path.join(dir, "node_modules", "openclaw");
      if (safeExists(cand)) roots.add(cand);
      // The entry might ALREADY live inside an openclaw install
      const idx = dir.lastIndexOf(`${path.sep}openclaw`);
      if (idx >= 0) {
        const openclawRoot = dir.slice(0, idx + `${path.sep}openclaw`.length);
        if (safeExists(path.join(openclawRoot, "package.json"))) {
          roots.add(openclawRoot);
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // 2. Common global install locations
  const candidates: Array<string | undefined> = [
    // Homebrew (macOS)
    "/opt/homebrew/lib/node_modules/openclaw",
    // Linux / older macOS
    "/usr/local/lib/node_modules/openclaw",
    // npm prefix env hint
    process.env.npm_config_prefix
      ? path.join(process.env.npm_config_prefix, "lib", "node_modules", "openclaw")
      : undefined,
    // nvm (POSIX)
    process.env.NVM_BIN
      ? path.resolve(process.env.NVM_BIN, "..", "lib", "node_modules", "openclaw")
      : undefined,
    // Volta
    process.env.VOLTA_HOME
      ? path.join(process.env.VOLTA_HOME, "tools", "image", "packages", "openclaw", "lib", "node_modules", "openclaw")
      : undefined,
    // Windows global
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "openclaw")
      : undefined,
    // NemoClaw bundle
    path.join(os.homedir(), ".nemoclaw", "source", "node_modules", "openclaw"),
    // OpenClaw sidecar (self-contained install under ~/.openclaw)
    path.join(os.homedir(), ".openclaw", "lib", "node_modules", "openclaw"),
    path.join(os.homedir(), ".openclaw", "tools", "node", "lib", "node_modules", "openclaw"),
  ];
  for (const c of candidates) {
    if (c && safeExists(path.join(c, "package.json"))) roots.add(c);
  }

  return Array.from(roots);
}

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Multi-strategy importer for OpenClaw SDK subpaths.
 *
 * Strategies (in order):
 *   1. Direct `import(spec)` — works when the plugin is loaded via a resolver
 *      that includes openclaw in the module path.
 *   2. `createRequire(import.meta.url).resolve(spec)` — asks Node to do the
 *      work from the plugin file's location.
 *   3. Direct file-URL import of `<openclawRoot>/dist/<sub>.js` for every
 *      discovered openclaw install root. Bypasses the package.json `exports`
 *      field when a subpath isn't explicitly exported.
 *
 * Returns the first strategy that succeeds along with diagnostic info.
 * Throws an aggregated error when every strategy fails.
 */
export async function importSdk(spec: string): Promise<SdkImportResult> {
  const errors: SdkImportError[] = [];

  // Strategy 1: direct dynamic import
  try {
    const module = await import(spec);
    return { module, strategy: "direct-import", resolvedFrom: spec };
  } catch (e) {
    errors.push({ strategy: "direct-import", message: describe(e) });
  }

  // Strategy 2: createRequire from this file
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve(spec);
    const module = await import(pathToFileURL(resolved).href);
    return { module, strategy: "create-require", resolvedFrom: resolved };
  } catch (e) {
    errors.push({ strategy: "create-require", message: describe(e) });
  }

  // Strategy 3: probe install roots with file URLs
  const sub = spec.replace(/^openclaw\//, "");
  const roots = findOpenclawRoots();
  for (const root of roots) {
    const file = path.join(root, "dist", `${sub}.js`);
    if (!safeExists(file)) {
      errors.push({ strategy: `file-url:${root}`, message: `missing ${file}` });
      continue;
    }
    try {
      const module = await import(pathToFileURL(file).href);
      return { module, strategy: "file-url", resolvedFrom: file };
    } catch (e) {
      errors.push({ strategy: `file-url:${root}`, message: describe(e) });
    }
  }

  const summary = errors.map((e) => `  [${e.strategy}] ${e.message}`).join("\n");
  throw new Error(
    `automode: cannot import '${spec}'. Tried ${errors.length} strategy/strategies:\n${summary}\n` +
      `Hint: ensure openclaw is installed globally (e.g. /opt/homebrew/lib/node_modules/openclaw on macOS).`,
  );
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return (err.message ?? "unknown error").replace(/\n/g, " ").slice(0, 300);
  }
  return String(err).slice(0, 300);
}
