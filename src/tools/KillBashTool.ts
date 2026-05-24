import { z } from "zod";
import { buildTool } from "./Tool.js";
import { killShell } from "../backgroundShells.js";

const inputSchema = z.object({
  shell_id: z.string().describe("終了させるシェルの ID（bash_001 等）"),
});

export const KillBashTool = buildTool({
  name: "kill_bash",
  description: "バックグラウンドシェルに SIGTERM を送って終了させる。",
  inputSchema,
  isReadOnly: false,
  async call({ shell_id }, _context) {
    const found = killShell(shell_id);
    if (!found) {
      return { type: "error", text: `シェル ID "${shell_id}" が見つかりません。` };
    }
    return { type: "text", text: `シェル ${shell_id} に SIGTERM を送信しました。` };
  },
});
