import { z } from "zod";
import { exec, execSync } from "child_process";
import * as path from "path";
import { buildTool } from "./Tool.js";

const inputSchema = z.object({
  pattern: z.string().describe("検索する正規表現パターン"),
  path: z.string().optional().describe("検索するディレクトリまたはファイル"),
  glob: z.string().optional().describe("対象ファイルのglobパターン（例: *.ts）"),
  case_insensitive: z.boolean().optional().describe("大文字小文字を無視する"),
  context: z.number().optional().describe("前後の表示行数"),
});

let hasRgCached: boolean | null = null;
function hasRg(): boolean {
  if (hasRgCached !== null) return hasRgCached;
  try { execSync("which rg", { stdio: "pipe" }); hasRgCached = true; }
  catch { hasRgCached = false; }
  return hasRgCached;
}

export const GrepTool = buildTool({
  name: "grep",
  description: "ファイル内のテキストを正規表現で検索する。コードや文字列の検索に使う。",
  inputSchema,
  isReadOnly: true,
  async call({ pattern, path: searchPath, glob: globPattern, case_insensitive, context }, ctx) {
    const root = searchPath ? path.resolve(ctx.cwd, searchPath) : ctx.cwd;

    let cmd: string;
    if (hasRg()) {
      const flags = [
        case_insensitive ? "-i" : "",
        context ? `-C ${context}` : "",
        globPattern ? `-g '${globPattern}'` : "",
        "--no-heading", "-n", "--max-count=250",
        `'${pattern.replace(/'/g, "'\\''")}'`,
        `'${root}'`,
      ].filter(Boolean).join(" ");
      cmd = `rg ${flags}`;
    } else {
      const flags = [
        "-r",
        case_insensitive ? "-i" : "",
        context ? `-C ${context}` : "-n",
        globPattern ? `--include='${globPattern}'` : "",
        `'${pattern.replace(/'/g, "'\\''")}'`,
        `'${root}'`,
      ].filter(Boolean).join(" ");
      cmd = `grep ${flags}`;
    }

    const result = await new Promise<{ stdout: string; status: number | null; killed: boolean }>(
      (resolve) => {
        const child = exec(cmd, {
          cwd: ctx.cwd,
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
          encoding: "utf8",
        }, (err, stdout) => {
          resolve({
            stdout: stdout ?? "",
            status: err?.code as number | null ?? 0,
            killed: !!err?.killed,
          });
        });
        if (ctx.abortSignal) {
          const onAbort = () => child.kill("SIGTERM");
          ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
          child.once("exit", () => ctx.abortSignal!.removeEventListener("abort", onAbort));
        }
      },
    );

    if (result.killed || ctx.abortSignal?.aborted) {
      return { type: "error", text: "検索を中断しました（タイムアウトまたは中断）。" };
    }
    if (result.status === 1) return { type: "text", text: "一致なし" };

    const lines = result.stdout.split("\n").slice(0, 250);
    return { type: "text", text: lines.join("\n") || "一致なし" };
  },
});
