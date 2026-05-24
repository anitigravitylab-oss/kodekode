import { z } from "zod";
import { glob } from "glob";
import * as path from "path";
import { buildTool } from "./Tool.js";

const inputSchema = z.object({
  pattern: z.string().describe("globパターン（例: src/**/*.ts, *.json）"),
  path: z.string().optional().describe("検索するディレクトリ（デフォルト: カレント）"),
});

export const GlobTool = buildTool({
  name: "glob",
  description: "globパターンでファイルを検索する。ファイル一覧の取得に使う。",
  inputSchema,
  isReadOnly: true,
  async call({ pattern, path: searchPath }, { cwd }) {
    const root = searchPath ? path.resolve(cwd, searchPath) : cwd;
    try {
      const files = await glob(pattern, {
        cwd: root,
        ignore: ["node_modules/**", ".git/**"],
      });
      if (files.length === 0) return { type: "text", text: "一致するファイルなし" };
      const truncated = files.slice(0, 100);
      const result = truncated.join("\n") + (files.length > 100 ? `\n…（${files.length - 100}件省略）` : "");
      return { type: "text", text: result };
    } catch (e) {
      return { type: "error", text: `検索エラー: ${(e as Error).message}` };
    }
  },
});
