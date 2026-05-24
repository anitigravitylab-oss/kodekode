import { z } from "zod";
import { exec } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { buildTool } from "./Tool.js";
import { spawnBackgroundShell } from "../backgroundShells.js";

const MAX_OUTPUT = 50000;

const inputSchema = z.object({
  command: z.string().describe("実行するシェルコマンド"),
  timeout: z.number().optional().describe("タイムアウト ms（デフォルト 60000）"),
  run_in_background: z.boolean().optional().describe("true にするとバックグラウンドで実行し shell_id を即座に返す"),
  description: z.string().optional().describe("バックグラウンド実行時の説明（省略可）"),
});

export const BashTool = buildTool({
  name: "bash",
  description:
    "シェルコマンドを実行して stdout/stderr を返す。ビルド・テスト・git・パッケージ操作等に使う。" +
    "ファイル操作には read_file/write_file/edit_file を優先すること。" +
    "run_in_background:true でバックグラウンド実行（bash_output で出力確認）。",
  inputSchema,
  isReadOnly: false,
  async call({ command, timeout = 60000, run_in_background = false, description = "" }, context) {
    // Background execution mode
    if (run_in_background) {
      const shellId = spawnBackgroundShell(command, context.cwd, description || command.slice(0, 60));
      return {
        type: "text",
        text: JSON.stringify({ shell_id: shellId, description: description || command.slice(0, 60) }),
      };
    }

    const pwdFile = `/tmp/.kk_pwd_${process.pid}`;
    const wrapped = `(${command})\n__kk_rc=$?\npwd > ${pwdFile} 2>/dev/null\nexit $__kk_rc`;

    const result = await new Promise<{ stdout: string; stderr: string; code: number | null; killed: boolean }>(
      (resolve) => {
        const child = exec(wrapped, {
          cwd: context.cwd,
          timeout,
          encoding: "utf8",
          shell: "/bin/bash",
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        }, (err, stdout, stderr) => {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: err?.code as number | null ?? 0,
            killed: !!err?.killed,
          });
        });

        if (context.abortSignal) {
          const onAbort = () => { child.kill("SIGTERM"); };
          context.abortSignal.addEventListener("abort", onAbort, { once: true });
          child.once("exit", () => context.abortSignal!.removeEventListener("abort", onAbort));
        }
      },
    );

    // Update shared cwd
    try {
      const newCwd = readFileSync(pwdFile, "utf8").trim();
      if (newCwd) context.cwd = newCwd;
      unlinkSync(pwdFile);
    } catch {}

    if (result.killed || context.abortSignal?.aborted) {
      return { type: "error", text: "コマンドを中断しました。" };
    }

    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)";
    const text = combined.length > MAX_OUTPUT
      ? combined.slice(0, MAX_OUTPUT) + `\n…(${combined.length - MAX_OUTPUT} 文字省略)`
      : combined;

    return { type: result.code === 0 ? "text" : "error", text };
  },
});
