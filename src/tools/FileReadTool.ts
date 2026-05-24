import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { buildTool } from "./Tool.js";

const inputSchema = z.object({
  file_path: z.string().describe("読み込むファイルのパス"),
  offset: z.number().optional().describe("開始行（1始まり）"),
  limit: z.number().optional().describe("読み込む行数"),
});

export const FileReadTool = buildTool({
  name: "read_file",
  description:
    "ファイルの内容を行番号付きで読む。offset/limit で部分読み込みも可能。",
  inputSchema,
  isReadOnly: true,
  async call({ file_path, offset, limit }, { cwd }) {
    const abs = path.resolve(cwd, file_path);
    try {
      const content = fs.readFileSync(abs, "utf8");
      const lines = content.split("\n");
      const start = offset ? offset - 1 : 0;
      const end = limit ? start + limit : lines.length;
      const slice = lines.slice(start, end);
      const numbered = slice
        .map((line, i) => `${String(start + i + 1).padStart(4, " ")}│${line}`)
        .join("\n");
      return { type: "text", text: numbered };
    } catch (e) {
      return { type: "error", text: `読み込みエラー: ${(e as Error).message}` };
    }
  },
});
