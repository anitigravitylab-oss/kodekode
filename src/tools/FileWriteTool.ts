import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { buildTool } from "./Tool.js";

const inputSchema = z.object({
  file_path: z.string().describe("書き込むファイルのパス"),
  content: z.string().describe("書き込む内容"),
});

export const FileWriteTool = buildTool({
  name: "write_file",
  description: "ファイルを新規作成または上書きする。ディレクトリが存在しない場合は作成する。",
  inputSchema,
  isReadOnly: false,
  async call({ file_path, content }, { cwd }) {
    const abs = path.resolve(cwd, file_path);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const exists = fs.existsSync(abs);
      fs.writeFileSync(abs, content, "utf8");
      return {
        type: "text",
        text: `${exists ? "上書き" : "新規作成"}: ${file_path}`,
      };
    } catch (e) {
      return { type: "error", text: `書き込みエラー: ${(e as Error).message}` };
    }
  },
});
