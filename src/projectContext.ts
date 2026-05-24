import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

function findGitRoot(startDir: string): string | null {
  try {
    const result = execSync("git rev-parse --show-toplevel 2>/dev/null", {
      cwd: startDir,
      encoding: "utf8",
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Walk up from startDir looking for CLAUDE.md files.
 * Returns list of { path, content } from farthest ancestor to cwd.
 */
function collectClaudeMdFiles(startDir: string): Array<{ path: string; content: string }> {
  const found: Array<{ path: string; content: string }> = [];
  const gitRoot = findGitRoot(startDir);
  const stopAt = gitRoot ?? "/";

  let current = startDir;
  while (true) {
    const candidate = join(current, "CLAUDE.md");
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, "utf8").trim();
        if (content) found.push({ path: candidate, content });
      } catch {}
    }
    if (current === stopAt || current === "/" || current === dirname(current)) break;
    current = dirname(current);
  }

  // found is ordered [cwd → root], reverse to get [root → cwd]
  found.reverse();
  return found;
}

/**
 * Load project context from CLAUDE.md files.
 * Searches: cwd upward (to git root or /), then ~/.kodekode/CLAUDE.md.
 * Returns a string to inject into the system prompt, or "" if nothing found.
 */
export function loadProjectContext(cwd: string): string {
  const files = collectClaudeMdFiles(cwd);

  // Add global ~/.kodekode/CLAUDE.md at the beginning (lowest priority)
  const globalPath = join(homedir(), ".kodekode", "CLAUDE.md");
  if (existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, "utf8").trim();
      if (content) {
        // Put global first (lowest specificity)
        files.unshift({ path: globalPath, content });
      }
    } catch {}
  }

  if (files.length === 0) return "";

  const sections = files.map((f) => `<!-- from: ${f.path} -->\n${f.content}`).join("\n\n");
  return `<project_context>\n${sections}\n</project_context>`;
}
