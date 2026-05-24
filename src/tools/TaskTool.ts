import { z } from "zod";
import { buildTool } from "./Tool.js";
import { appendFileSync } from "fs";

function dbg(msg: string) {
  const t = new Date().toISOString().slice(11, 23);
  appendFileSync("/tmp/kodekode.log", `[${t}] [task] ${msg}\n`);
}

const inputSchema = z.object({
  description: z.string().describe("タスクの概要"),
  prompt: z.string().describe("サブエージェントに渡すプロンプト"),
  subagent_type: z
    .enum(["general", "research", "code-review"])
    .optional()
    .describe("サブエージェントのタイプ（省略時: general）"),
});

/** Injected by agent.ts at startup */
export type AgentSpawner = (prompt: string, systemSuffix: string) => Promise<string>;
let _spawner: AgentSpawner | null = null;

export function setAgentSpawner(spawner: AgentSpawner) {
  _spawner = spawner;
}

const SUBAGENT_SYSTEM_SUFFIXES: Record<string, string> = {
  general: "",
  research:
    "\n\n# Subagent mode: research\nYou are a research subagent. Prefer read-only tools (read_file, glob, grep, web_search, web_fetch). Do NOT write or edit files unless absolutely necessary.",
  "code-review":
    "\n\n# Subagent mode: code-review\nYou are a code review subagent. Analyze the code and produce a concise list of issues. Do NOT write or modify any files.",
};

export const TaskTool = buildTool({
  name: "task",
  description:
    "別のサブエージェントを起動して独立したタスクを実行させる。サブエージェントの最終回答を返す。長い調査・コードレビュー等を並列/隔離して実行したいときに使う。",
  inputSchema,
  isReadOnly: false,
  async call({ description, prompt, subagent_type = "general" }, _context) {
    if (!_spawner) {
      return { type: "error", text: "AgentSpawner が設定されていません。" };
    }

    dbg(`spawning subagent: type=${subagent_type} desc=${description.slice(0, 60)}`);
    const systemSuffix = SUBAGENT_SYSTEM_SUFFIXES[subagent_type] ?? "";

    try {
      const result = await _spawner(prompt, systemSuffix);
      dbg(`subagent done: result length=${result.length}`);
      return { type: "text", text: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dbg(`subagent error: ${msg}`);
      return { type: "error", text: `サブエージェントエラー: ${msg}` };
    }
  },
});
