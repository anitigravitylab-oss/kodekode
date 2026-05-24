import { z } from "zod";
import { buildTool } from "./Tool.js";
import { getShellOutput } from "../backgroundShells.js";

const inputSchema = z.object({
  shell_id: z.string().describe("bash_001 等のシェル ID"),
  since_line: z.number().optional().describe("この行番号以降の出力を返す（デフォルト 0）"),
});

export const BashOutputTool = buildTool({
  name: "bash_output",
  description: "バックグラウンドで実行中のシェルの出力を取得する。shell_id は bash ツールの run_in_background:true で返された値を使う。",
  inputSchema,
  isReadOnly: true,
  async call({ shell_id, since_line = 0 }, _context) {
    const info = getShellOutput(shell_id, since_line);
    if (!info) {
      return { type: "error", text: `シェル ID "${shell_id}" が見つかりません。` };
    }
    const output = {
      shell_id,
      running: info.running,
      exitCode: info.exitCode,
      totalLines: info.totalLines,
      newLines: info.lines,
    };
    return { type: "text", text: JSON.stringify(output, null, 2) };
  },
});
