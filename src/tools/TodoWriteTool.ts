import { z } from "zod";
import { buildTool } from "./Tool.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  content: string;
  status: TodoStatus;
  priority?: string;
};

const todoItemSchema = z.object({
  content: z.string().describe("タスクの内容"),
  status: z.enum(["pending", "in_progress", "completed"]).describe("タスクの状態"),
  priority: z.string().optional().describe("優先度 (high/medium/low)"),
});

const inputSchema = z.object({
  todos: z.array(todoItemSchema).describe("Todoリスト全体（常に全件を渡すこと）"),
});

// Global todo state — updated by the tool, read by App.tsx
export const globalTodos: { items: TodoItem[] } = { items: [] };

export const TodoWriteTool = buildTool({
  name: "todo_write",
  description:
    "Todoリストを更新する。複数ステップのタスクで進捗を管理するために使う。" +
    "タスク開始時・各ステップ完了時・全体完了時に呼ぶ。常にリスト全体を渡すこと。",
  inputSchema,
  isReadOnly: false,
  async call({ todos }) {
    globalTodos.items = todos;
    const summary = todos.map((t) => {
      const mark = t.status === "completed" ? "☒" : t.status === "in_progress" ? "◐" : "☐";
      return `${mark} ${t.content}`;
    }).join(", ");
    return { type: "text", text: `Todoリストを更新しました (${todos.length}件): ${summary}` };
  },
});
