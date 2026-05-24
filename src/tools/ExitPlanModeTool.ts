import { z } from "zod";
import { buildTool } from "./Tool.js";

const inputSchema = z.object({
  plan: z.string().describe("ユーザーに提示する実行計画"),
});

/**
 * ExitPlanModeTool — Plan モードでエージェントが計画を提示するためのツール。
 * 実際のモード切替は App.tsx 側で行う（このツールの呼び出しを検出してダイアログを出す）。
 * ここでは計画テキストをそのまま返すだけ。
 */
export const ExitPlanModeTool = buildTool({
  name: "exit_plan_mode",
  description: "Plan モードで計画立案が完了したときに呼ぶ。plan に実行計画を書いて提示し、ユーザーの承認を待つ。",
  inputSchema,
  isReadOnly: true,
  async call({ plan }, _context) {
    // The actual dialog/mode-switch is handled by App.tsx intercepting this tool_use event.
    // We return the plan text; agent loop in agent.ts will yield the result back to the model.
    return {
      type: "text",
      text: `__EXIT_PLAN_MODE__:${plan}`,
    };
  },
});
