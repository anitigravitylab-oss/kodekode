import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type CustomCommand = {
  name: string;       // e.g. "refactor"
  description: string;
  template: string;   // raw template (frontmatter stripped)
};

/** Parse YAML-ish frontmatter: --- key: value --- */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta, body: raw };
  const frontmatter = match[1]!;
  const body = match[2]!;
  for (const line of frontmatter.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  return { meta, body };
}

let _cache: CustomCommand[] | null = null;
let _cacheTime = 0;
const CACHE_TTL = 5000; // 5s

/** Load all custom commands from ~/.kodekode/commands/*.md */
export function loadCustomCommands(): CustomCommand[] {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;

  const dir = join(homedir(), ".kodekode", "commands");
  if (!existsSync(dir)) {
    _cache = [];
    _cacheTime = now;
    return [];
  }

  const cmds: CustomCommand[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    _cache = [];
    _cacheTime = now;
    return [];
  }

  for (const file of files) {
    const name = file.replace(/\.md$/, "");
    try {
      const raw = readFileSync(join(dir, file), "utf8");
      const { meta, body } = parseFrontmatter(raw);
      cmds.push({
        name,
        description: meta["description"] ?? "",
        template: body.trim(),
      });
    } catch {}
  }

  _cache = cmds;
  _cacheTime = now;
  return cmds;
}

/** Expand a custom command template with given args and context */
export function expandCommand(template: string, args: string, cwd: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return template
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\{\{cwd\}\}/g, cwd)
    .replace(/\{\{date\}\}/g, date);
}

/** Find a custom command by name (returns null if not found) */
export function findCustomCommand(name: string): CustomCommand | null {
  return loadCustomCommands().find((c) => c.name === name) ?? null;
}
