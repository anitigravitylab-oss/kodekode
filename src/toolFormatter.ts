// Tool call display formatters — Claude Code style

type ToolInput = Record<string, unknown>;

/** Format tool call as a compact 1-line label: "● ToolName(summary)" */
export function formatToolCall(name: string, input: unknown): string {
  const inp = input as ToolInput;
  switch (name) {
    case "bash": {
      const cmd = String(inp["command"] ?? "").replace(/\n/g, " ").slice(0, 80);
      return `● Bash($ ${cmd})`;
    }
    case "read_file": {
      const p = shortPath(String(inp["file_path"] ?? ""));
      return `● Read(${p})`;
    }
    case "write_file": {
      const p = shortPath(String(inp["file_path"] ?? ""));
      return `● Write(${p})`;
    }
    case "edit_file": {
      const p = shortPath(String(inp["file_path"] ?? ""));
      return `● Edit(${p})`;
    }
    case "grep": {
      const pat = String(inp["pattern"] ?? "").slice(0, 40);
      const path = inp["path"] ? ` in ${shortPath(String(inp["path"]))}` : "";
      return `● Grep(${pat}${path})`;
    }
    case "glob": {
      const pat = String(inp["pattern"] ?? "").slice(0, 60);
      return `● Glob(${pat})`;
    }
    case "todo_write": {
      const todos = inp["todos"];
      const count = Array.isArray(todos) ? todos.length : "?";
      return `● TodoWrite(${count} items)`;
    }
    default: {
      const summary = JSON.stringify(input).slice(0, 80);
      return `● ${name}(${summary})`;
    }
  }
}

/** Format tool result as a compact summary line */
export function formatToolResult(
  name: string,
  result: string,
  isError: boolean,
  elapsed: number,
): string {
  const timeStr = elapsed > 0 ? ` (${(elapsed / 1000).toFixed(1)}s)` : "";
  if (isError) {
    return `└ Error: ${result.slice(0, 100)}${timeStr}`;
  }
  switch (name) {
    case "bash": {
      const lines = result.split("\n").filter((l) => l.trim());
      if (lines.length === 0) return `└ (no output)${timeStr}`;
      const preview = lines[0]?.slice(0, 80) ?? "";
      const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
      return `└ ${preview}${more}${timeStr}`;
    }
    case "read_file": {
      const lineCount = result.split("\n").length;
      return `└ ${lineCount} lines${timeStr}`;
    }
    case "write_file":
    case "edit_file": {
      return `└ ${result.slice(0, 80)}${timeStr}`;
    }
    case "grep": {
      const matches = result === "一致なし" ? 0 : result.split("\n").filter(Boolean).length;
      return `└ ${matches} matches${timeStr}`;
    }
    case "glob": {
      const count = result === "一致するファイルなし" ? 0 : result.split("\n").filter(Boolean).length;
      return `└ ${count} files${timeStr}`;
    }
    case "todo_write": {
      return `└ ${result.slice(0, 80)}${timeStr}`;
    }
    default: {
      const preview = result.split("\n")[0]?.slice(0, 80) ?? "";
      return `└ ${preview}${timeStr}`;
    }
  }
}

function shortPath(p: string): string {
  // Strip long leading paths, keep last 3 components
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return "…/" + parts.slice(-3).join("/");
}
