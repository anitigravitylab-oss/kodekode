import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { buildTool } from "./Tool.js";

const inputSchema = z.object({
  file_path: z.string().describe("編集するファイルのパス"),
  old_string: z.string().describe("置き換える元の文字列（ファイル内に一致する必要がある）"),
  new_string: z.string().describe("置き換え後の文字列"),
  replace_all: z.boolean().optional().describe("すべての一致箇所を置き換える（デフォルト: false）"),
});

export const FileEditTool = buildTool({
  name: "edit_file",
  description:
    "ファイル内の文字列を置き換える。old_string はファイル内に一意に存在する必要がある。",
  inputSchema,
  isReadOnly: false,
  async call({ file_path, old_string, new_string, replace_all = false }, { cwd }) {
    const abs = path.resolve(cwd, file_path);
    try {
      const content = fs.readFileSync(abs, "utf8");

      if (!content.includes(old_string)) {
        return { type: "error", text: `old_string がファイル内に見つかりません: ${file_path}` };
      }

      if (!replace_all) {
        const count = content.split(old_string).length - 1;
        if (count > 1) {
          return {
            type: "error",
            text: `old_string が ${count} 箇所見つかりました。一意にするか replace_all: true を指定してください。`,
          };
        }
      }

      const updated = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string);

      fs.writeFileSync(abs, updated, "utf8");
      return { type: "text", text: `編集完了: ${file_path}` };
    } catch (e) {
      return { type: "error", text: `編集エラー: ${(e as Error).message}` };
    }
  },
});
