import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "./TextInput.js";
import Selector from "./Selector.js";
import PermissionPrompt from "./PermissionPrompt.js";
import { runAgent } from "./agent.js";
import { runOpenAIAgent, ensureProxy } from "./openaiAgent.js";
import { runGeminiAgent } from "./geminiAgent.js";
import { saveSession, listSessions } from "./session.js";
import type { History, ProviderType, GeminiContent, PermissionDecision, PermissionRequest } from "./types.js";
import { loadConfig, saveConfig, applyConfig } from "./config.js";
import { formatToolCall, formatToolResult } from "./toolFormatter.js";
import { renderMarkdown } from "./markdown.js";
import { globalTodos } from "./tools/TodoWriteTool.js";
import type { TodoItem } from "./tools/TodoWriteTool.js";
import { loadProjectContext } from "./projectContext.js";
import { loadCustomCommands, expandCommand, findCustomCommand } from "./customCommands.js";
import { mkdirSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

type ModelEntry = {
  label: string;
  value: string;
  provider: ProviderType;
};

const MODELS: ModelEntry[] = [
  // DeepSeek (v4系 — 2026/04リリース、1Mコンテキスト)
  { label: "deepseek-v4-pro",        value: "deepseek-v4-pro",        provider: "deepseek" },
  { label: "deepseek-v4-flash",      value: "deepseek-v4-flash",      provider: "deepseek" },
  // Claude (2025〜2026)
  { label: "claude-opus-4-7",        value: "claude-opus-4-7",        provider: "anthropic" },
  { label: "claude-sonnet-4-6",      value: "claude-sonnet-4-6",      provider: "anthropic" },
  { label: "claude-haiku-4-5",       value: "claude-haiku-4-5-20251001", provider: "anthropic" },
  // OpenAI OAuth (ChatGPT サブスク)
  { label: "gpt-5.5",                value: "gpt-5.5",                provider: "openai-oauth" },
  { label: "gpt-5.4",                value: "gpt-5.4",                provider: "openai-oauth" },
  { label: "gpt-5.4-mini",           value: "gpt-5.4-mini",           provider: "openai-oauth" },
  // OpenAI API (API キー)
  { label: "gpt-5.5",                value: "gpt-5.5",                provider: "openai-api" },
  { label: "gpt-5.4",                value: "gpt-5.4",                provider: "openai-api" },
  { label: "gpt-5.4-mini",           value: "gpt-5.4-mini",           provider: "openai-api" },
  // Gemini (2026年現行モデル)
  { label: "gemini-3.5-flash",        value: "gemini-3.5-flash",        provider: "gemini" },
  { label: "gemini-3.1-pro-preview", value: "gemini-3.1-pro-preview", provider: "gemini" },
  { label: "gemini-3.1-flash-lite",  value: "gemini-3.1-flash-lite",  provider: "gemini" },
];

const PROVIDER_LABELS: Record<ProviderType, string> = {
  "deepseek":    "DeepSeek",
  "anthropic":   "Claude",
  "openai-oauth": "OpenAI OAuth",
  "openai-api":  "OpenAI API",
  "gemini":      "Gemini",
};

// Model pricing (per 1M tokens) for /cost command
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7":         { input: 15,   output: 75   },
  "claude-sonnet-4-6":       { input: 3,    output: 15   },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4   },
  "deepseek-v4-pro":         { input: 0.27, output: 1.1  },
  "deepseek-v4-flash":       { input: 0.07, output: 0.28 },
  "gpt-5.5":                 { input: 5,    output: 15   },
  "gpt-5.4":                 { input: 2.5,  output: 10   },
  "gpt-5.4-mini":            { input: 0.15, output: 0.60 },
  "gemini-3.5-flash":        { input: 0.075,output: 0.30 },
  "gemini-3.1-pro-preview":  { input: 3.5,  output: 10.5 },
  "gemini-3.1-flash-lite":   { input: 0.02, output: 0.04 },
};

function isConfigured(provider: ProviderType): boolean {
  switch (provider) {
    case "deepseek":    return !!process.env.DEEPSEEK_API_KEY;
    case "anthropic":   return !!process.env.ANTHROPIC_API_KEY;
    case "openai-oauth": return true; // proxy/auth handled at runtime
    case "openai-api":  return !!process.env.OPENAI_API_KEY;
    case "gemini":      return !!process.env.GEMINI_API_KEY;
  }
}

function getDefaultModel(): ModelEntry {
  const config = loadConfig();
  if (config?.defaultProvider) {
    const m = MODELS.find((m) => m.provider === config.defaultProvider);
    if (m) return m;
  }
  const preferred: ProviderType[] = ["openai-oauth", "anthropic", "deepseek", "openai-api", "gemini"];
  for (const p of preferred) {
    if (isConfigured(p)) {
      const m = MODELS.find((m) => m.provider === p);
      if (m) return m;
    }
  }
  return MODELS[0]!;
}

/** サブエージェントのモデル・APIキー・baseURL を config から解決する */
function resolveSubagentConfig(): { model: string; apiKey: string; baseURL: string } | null {
  const config = loadConfig();
  if (!config?.subagentModel) return null;
  const subModel = MODELS.find((m) => m.value === config.subagentModel);
  if (!subModel) return null;
  const provider = subModel.provider;
  let apiKey = "";
  let baseURL = "";
  switch (provider) {
    case "deepseek":
      apiKey = process.env.DEEPSEEK_API_KEY ?? "";
      baseURL = "https://api.deepseek.com/anthropic";
      break;
    case "anthropic":
      apiKey = process.env.ANTHROPIC_API_KEY ?? "";
      baseURL = "https://api.anthropic.com";
      break;
    case "openai-oauth":
    case "openai-api":
      // OpenAI は anthropic 互換 API でないためスキップ
      return null;
    case "gemini":
      // Gemini も anthropic 互換でないためスキップ
      return null;
    default:
      return null;
  }
  if (!apiKey) return null;
  return { model: subModel.value, apiKey, baseURL };
}

function buildHelpText(): string {
  const builtinLines = [
    "/help            コマンド一覧を表示",
    "/model           モデルを選択して切り替え",
    "/clear           会話履歴をリセット",
    "/compact         会話を要約してトークンを節約",
    "/resume          過去のセッションを選択して復元",
    "/plan            プランモードをトグル（計画のみ、実行なし）",
    "/login           OpenAI 再認証（再起動が必要）",
    "/cost            累計トークン使用量とコスト推定",
    "/diff            このセッションで変更されたファイルの diff",
    "/init            現ディレクトリを解析して CLAUDE.md を生成",
    "/yolo            ツール許可確認をスキップ（YOLOモード切替）",
    "/exit            終了",
    "Ctrl+C           終了",
    "↑ / ↓           入力履歴を移動",
    "← / →  Ctrl+A/E カーソル移動 / 行頭行末",
    "@ ファイル名補完（Tab で確定）",
    "! 行頭: シェル直接実行モード",
    "# 行頭: ~/.kodekode/notes.md にメモ追記",
  ];

  const customCmds = loadCustomCommands();
  const customLines = customCmds.map((c) => `/${c.name.padEnd(16)} ${c.description || "(カスタムコマンド)"}`);

  const lines = [...builtinLines];
  if (customLines.length > 0) {
    lines.push("", "--- カスタムコマンド ---");
    lines.push(...customLines);
  }
  return lines.join("\n");
}

// Message types with turn grouping
type ToolCallMsg = {
  role: "tool_call";
  name: string;
  label: string;   // formatted 1-liner
};
type ToolResultMsg = {
  role: "tool_result";
  name: string;
  label: string;   // formatted summary
  isError: boolean;
  elapsed: number;
};
type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; rendered?: string }
  | ToolCallMsg
  | ToolResultMsg
  | { role: "system"; text: string };

type SelectMode = { type: "model" } | { type: "resume" };
type SetupTarget = { entry: ModelEntry; step: "key" | "oauth_wait" };

// Plan mode confirmation dialog state
type PlanConfirmState = {
  plan: string;
  resolve: (approved: boolean) => void;
};

// TodoPanel component
function TodoPanel({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text bold color="cyan">Todos</Text>
      {todos.map((t, i) => {
        const mark = t.status === "completed" ? "☒" : t.status === "in_progress" ? "◐" : "☐";
        const color = t.status === "completed" ? "gray" : t.status === "in_progress" ? "yellow" : undefined;
        return (
          <Text key={i} color={color} dimColor={t.status === "completed"}>
            {mark} {t.content}
          </Text>
        );
      })}
    </Box>
  );
}

// PlanConfirm overlay
function PlanConfirmDialog({ plan, onDecide }: { plan: string; onDecide: (approved: boolean) => void }) {
  useInput((input, key) => {
    if (input.toLowerCase() === "y" || key.return) onDecide(true);
    if (input.toLowerCase() === "n" || key.escape) onDecide(false);
  });
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Text bold color="yellow">計画モード — 実行計画</Text>
      <Box marginY={1} flexDirection="column">
        <Text>{plan.slice(0, 1000)}{plan.length > 1000 ? "\n…(省略)" : ""}</Text>
      </Box>
      <Text bold>この計画で実行しますか? [Y]es / [N]o</Text>
    </Box>
  );
}

export default function App() {
  const { exit } = useApp();

  useEffect(() => {
    process.stdout.write("\x1b[>1u");
    return () => { process.stdout.write("\x1b[<u"); };
  }, []);

  const defaultEntry = getDefaultModel();
  const [messages, setMessages] = useState<Message[]>([]);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState("thinking...");
  const [history, setHistory] = useState<History>({ provider: defaultEntry.provider as "anthropic", messages: [] });
  const [currentEntry, setCurrentEntry] = useState<ModelEntry>(defaultEntry);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [selectMode, setSelectMode] = useState<SelectMode | null>(null);
  const [setupTarget, setSetupTarget] = useState<SetupTarget | null>(null);
  const setupTargetRef = useRef(setupTarget);
  useEffect(() => { setupTargetRef.current = setupTarget; }, [setupTarget]);

  // Plan mode
  const [planMode, setPlanMode] = useState(false);
  const planModeRef = useRef(false);
  useEffect(() => { planModeRef.current = planMode; }, [planMode]);
  const [planConfirm, setPlanConfirm] = useState<PlanConfirmState | null>(null);
  const planConfirmRef = useRef<PlanConfirmState | null>(null);
  useEffect(() => { planConfirmRef.current = planConfirm; }, [planConfirm]);

  // Todo state — read from globalTodos (updated by TodoWriteTool)
  const [todos, setTodos] = useState<TodoItem[]>([]);

  // Permission system
  const [yoloMode, setYoloMode] = useState(false);
  const yoloRef = useRef(false);
  useEffect(() => { yoloRef.current = yoloMode; }, [yoloMode]);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const permissionRef = useRef(pendingPermission);
  useEffect(() => { permissionRef.current = pendingPermission; }, [pendingPermission]);
  // Session-level "always allow" set
  const alwaysAllowRef = useRef<Set<string>>(new Set());

  // Token usage tracking (with cache tokens)
  const [sessionUsage, setSessionUsage] = useState({
    inputTokens: 0, outputTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0,
  });

  // AbortController for interrupting the running agent
  const abortRef = useRef<AbortController | null>(null);

  // Load project context once at startup
  const [projectContext] = useState(() => loadProjectContext(process.cwd()));

  // Poll global todos (set by TodoWriteTool)
  useEffect(() => {
    const interval = setInterval(() => {
      if (globalTodos.items.length !== todos.length ||
          JSON.stringify(globalTodos.items) !== JSON.stringify(todos)) {
        setTodos([...globalTodos.items]);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [todos]);

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "c") exit();
    if (key.escape) {
      if (setupTargetRef.current) { setSetupTarget(null); return; }
      if (planConfirmRef.current) { planConfirmRef.current.resolve(false); return; }
      if (abortRef.current && !abortRef.current.signal.aborted) {
        abortRef.current.abort("interrupt");
      }
    }
  });

  const addSystem = (text: string) =>
    setMessages((m) => [...m, { role: "system", text }]);

  const handleCommand = useCallback((raw: string) => {
    const parts = raw.trim().split(/\s+/);
    const cmd = parts[0] ?? "";
    const args = parts.slice(1).join(" ");

    // Check custom commands first
    const customName = cmd.slice(1); // strip leading /
    const customCmd = findCustomCommand(customName);
    if (customCmd) {
      const expanded = expandCommand(customCmd.template, args, process.cwd());
      // Treat expanded text as user message (will be submitted)
      // Return the expanded text so handleSubmit can process it
      return { type: "custom_command" as const, text: expanded };
    }

    switch (cmd) {
      case "/help":   addSystem(buildHelpText()); break;
      case "/clear":
        setMessages([]);
        setHistory({ provider: currentEntry.provider as "anthropic", messages: [] });
        setSessionUsage({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
        globalTodos.items = [];
        setTodos([]);
        addSystem("会話履歴をクリアしました。");
        break;
      case "/compact": {
        const msgCount = history.messages.length;
        if (msgCount === 0) { addSystem("圧縮する履歴がありません。"); break; }
        const keep = history.messages.slice(-6);
        setHistory({ ...history, messages: keep } as typeof history);
        setMessages((m) => {
          const sys = m.filter((x) => x.role === "system");
          return [...sys, { role: "system", text: `会話を圧縮しました（${msgCount} → ${keep.length} メッセージ）。直近 3 ターンを保持。` }];
        });
        break;
      }
      case "/plan": {
        const next = !planModeRef.current;
        setPlanMode(next);
        addSystem(next ? "[PLAN] プランモード ON: 読み取り専用ツールのみ使用。exit_plan_mode で計画提示。" : "プランモード OFF。");
        break;
      }
      case "/model":  setSelectMode({ type: "model" }); break;
      case "/resume": setSelectMode({ type: "resume" }); break;
      case "/login":  addSystem("再認証するには agent を終了して再起動してください。"); break;
      case "/exit":   exit(); break;
      case "/yolo": {
        const next = !yoloMode;
        setYoloMode(next);
        addSystem(next ? "YOLOモード ON: ツール実行確認をスキップします。" : "YOLOモード OFF: ツール実行前に確認します。");
        break;
      }
      case "/cost": {
        const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } = sessionUsage;
        const pricing = MODEL_PRICING[currentEntry.value];
        if (pricing) {
          const inputCost = (inputTokens / 1_000_000) * pricing.input;
          const outputCost = (outputTokens / 1_000_000) * pricing.output;
          const total = inputCost + outputCost;
          const cacheLines = cacheCreationTokens > 0 || cacheReadTokens > 0
            ? `\n  キャッシュ作成: ${cacheCreationTokens.toLocaleString()} tokens\n  キャッシュ読取: ${cacheReadTokens.toLocaleString()} tokens`
            : "";
          addSystem(
            `トークン使用量 (${currentEntry.value})\n` +
            `  入力: ${inputTokens.toLocaleString()} tokens  $${inputCost.toFixed(4)}\n` +
            `  出力: ${outputTokens.toLocaleString()} tokens  $${outputCost.toFixed(4)}\n` +
            `  合計: ${(inputTokens + outputTokens).toLocaleString()} tokens  $${total.toFixed(4)}` +
            cacheLines
          );
        } else {
          addSystem(
            `トークン使用量\n` +
            `  入力: ${sessionUsage.inputTokens.toLocaleString()} tokens\n` +
            `  出力: ${sessionUsage.outputTokens.toLocaleString()} tokens\n` +
            `  合計: ${(sessionUsage.inputTokens + sessionUsage.outputTokens).toLocaleString()} tokens`
          );
        }
        break;
      }
      case "/diff": {
        import("child_process").then(({ execSync }) => {
          try {
            const diff = execSync("git diff HEAD 2>/dev/null || git diff 2>/dev/null", {
              encoding: "utf8",
              maxBuffer: 1024 * 1024,
            });
            if (diff.trim()) {
              addSystem(`Git diff:\n${diff.slice(0, 2000)}${diff.length > 2000 ? "\n…(省略)" : ""}`);
            } else {
              addSystem("変更なし (git diff は空)");
            }
          } catch {
            addSystem("git diff の実行に失敗しました。git リポジトリでないか、git が入っていません。");
          }
        }).catch(() => addSystem("diff の取得に失敗しました。"));
        break;
      }
      case "/init": {
        import("child_process").then(({ execSync }) => {
          try {
            const files = execSync(
              "ls package.json README.md README.txt CLAUDE.md 2>/dev/null; find . -maxdepth 2 -name '*.ts' -o -name '*.tsx' -o -name '*.js' 2>/dev/null | head -20",
              { encoding: "utf8", maxBuffer: 100000 }
            );
            addSystem(
              `CLAUDE.md の生成には以下を参考にします:\n${files.slice(0, 500)}\n\n/init を実際に実行するには AI に「CLAUDE.md を生成して」と頼んでください。`
            );
          } catch {
            addSystem("ファイル一覧の取得に失敗しました。");
          }
        }).catch(() => addSystem("初期化に失敗しました。"));
        break;
      }
      default:        addSystem(`不明なコマンド: ${cmd}  (/help で一覧表示)`);
    }
    return null;
  }, [exit, currentEntry, yoloMode, sessionUsage, history]);

  // Permission checker passed to agents
  const permissionChecker = useCallback(
    async (toolName: string, preview: string): Promise<PermissionDecision> => {
      if (yoloRef.current) return "allow_once";
      if (alwaysAllowRef.current.has(toolName)) return "allow_once";
      return new Promise<PermissionDecision>((resolve) => {
        setPendingPermission({
          toolName,
          preview,
          resolve: (decision) => {
            if (decision === "always") alwaysAllowRef.current.add(toolName);
            setPendingPermission(null);
            resolve(decision);
          },
        });
      });
    },
    [],
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      if (!value.trim() || running) return;

      // Memo mode: lines starting with #
      if (value.startsWith("#")) {
        const notesDir = join(homedir(), ".kodekode");
        try {
          mkdirSync(notesDir, { recursive: true });
          appendFileSync(join(notesDir, "notes.md"), `${new Date().toISOString()} ${value.slice(1).trim()}\n`);
          addSystem("メモを ~/.kodekode/notes.md に追記しました。");
        } catch {
          addSystem("メモの保存に失敗しました。");
        }
        return;
      }

      if (value.startsWith("/")) {
        setInputHistory((h) => [value, ...h.filter((v) => v !== value)].slice(0, 100));
        const result = handleCommand(value);
        // Custom command returns { type: "custom_command", text }
        if (result?.type === "custom_command") {
          // Submit the expanded text as a user message to the agent
          await handleSubmit(result.text);
        }
        return;
      }
      setInputHistory((h) => [value, ...h.filter((v) => v !== value)].slice(0, 100));

      if (!isConfigured(currentEntry.provider)) {
        addSystem(`${PROVIDER_LABELS[currentEntry.provider]} は設定されていません。\n/model で別のモデルを選ぶか、agent を再起動して設定してください。`);
        return;
      }

      // Shell exec mode: lines starting with !
      let userText = value;
      if (value.startsWith("!")) {
        const cmd = value.slice(1).trim();
        setMessages((m) => [...m, { role: "user", text: value }]);
        setRunning(true);
        setRunStatus(`シェル実行中: ${cmd.slice(0, 40)}…`);
        try {
          const { execSync } = await import("child_process");
          const output = execSync(cmd, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30000 });
          setMessages((m) => [...m, {
            role: "tool_result",
            name: "bash",
            label: formatToolResult("bash", output, false, 0),
            isError: false,
            elapsed: 0,
          }]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setMessages((m) => [...m, {
            role: "tool_result",
            name: "bash",
            label: formatToolResult("bash", msg, true, 0),
            isError: true,
            elapsed: 0,
          }]);
        } finally {
          setRunning(false);
        }
        return;
      }

      setMessages((m) => [...m, { role: "user", text: userText }]);
      setRunning(true);

      const abort = new AbortController();
      abortRef.current = abort;
      setRunStatus("API 呼び出し中...");

      const subagentCfg = resolveSubagentConfig();

      try {
        type AnyGen = AsyncGenerator<import("./types.js").AgentEvent>;
        let gen: AnyGen;
        const { provider, value: model } = currentEntry;
        const signal = abort.signal;

        if (provider === "deepseek" || provider === "anthropic") {
          const msgs: Anthropic.MessageParam[] =
            (history.provider === "anthropic" || history.provider === "deepseek")
              ? [...(history.messages as Anthropic.MessageParam[]), { role: "user", content: userText }]
              : [{ role: "user", content: userText }];
          const apiKey = provider === "deepseek"
            ? (process.env.DEEPSEEK_API_KEY ?? "")
            : (process.env.ANTHROPIC_API_KEY ?? "");
          const baseURL = provider === "deepseek"
            ? "https://api.deepseek.com/anthropic"
            : "https://api.anthropic.com";
          gen = runAgent(msgs, model, {
            apiKey,
            baseURL,
            signal,
            permissionChecker,
            promptOpts: {
              planMode: planModeRef.current,
              projectContext: projectContext || undefined,
            },
            ...(subagentCfg ? {
              subagentModel: subagentCfg.model,
              subagentApiKey: subagentCfg.apiKey,
              subagentBaseURL: subagentCfg.baseURL,
            } : {}),
          });

        } else if (provider === "openai-oauth") {
          const status = await ensureProxy();
          if (status === "login_required") {
            addSystem("ChatGPT へのログインが必要です。agent を再起動してください。");
            setRunning(false);
            return;
          }
          if (status === "started") addSystem("OpenAI プロキシを起動しました。");
          const msgs: OpenAI.ChatCompletionMessageParam[] =
            (history.provider === "openai-oauth" || history.provider === "openai-api")
              ? [...(history.messages as OpenAI.ChatCompletionMessageParam[]), { role: "user", content: userText }]
              : [{ role: "user", content: userText }];
          gen = runOpenAIAgent(msgs, model, undefined, signal, subagentCfg ?? undefined);

        } else if (provider === "openai-api") {
          const msgs: OpenAI.ChatCompletionMessageParam[] =
            (history.provider === "openai-oauth" || history.provider === "openai-api")
              ? [...(history.messages as OpenAI.ChatCompletionMessageParam[]), { role: "user", content: userText }]
              : [{ role: "user", content: userText }];
          gen = runOpenAIAgent(msgs, model, process.env.OPENAI_API_KEY, signal, subagentCfg ?? undefined);

        } else { // gemini
          const msgs: GeminiContent[] =
            history.provider === "gemini"
              ? [...(history.messages as GeminiContent[]), { role: "user", parts: [{ text: userText }] }]
              : [{ role: "user", parts: [{ text: userText }] }];
          gen = runGeminiAgent(msgs, model, process.env.GEMINI_API_KEY ?? "", signal, subagentCfg ?? undefined);
        }

        let finalHistory: History = history;
        let thinkingChars = 0;
        for await (const event of gen) {
          if (event.type === "text_delta") {
            thinkingChars = 0;
            setMessages((m) => {
              const last = m[m.length - 1];
              if (last?.role === "assistant") {
                return [...m.slice(0, -1), { ...last, text: last.text + event.text, rendered: undefined }];
              }
              return [...m, { role: "assistant", text: event.text, rendered: undefined }];
            });
            setRunStatus("応答中...");
          } else if (event.type === "thinking_delta") {
            thinkingChars += event.text.length;
            setRunStatus(`思考中... (${thinkingChars}文字)`);
          } else if (event.type === "text" && event.text) {
            setMessages((m) => [...m, { role: "assistant", text: event.text, rendered: undefined }]);
            setRunStatus("応答中...");
          } else if (event.type === "tool_use") {
            thinkingChars = 0;
            const label = formatToolCall(event.name, event.input);
            setRunStatus(`実行中: ${event.name}...`);
            setMessages((m) => [...m, { role: "tool_call", name: event.name, label }]);
          } else if (event.type === "tool_result") {
            // Intercept exit_plan_mode tool to show confirmation dialog
            if (event.name === "exit_plan_mode" && event.result.startsWith("__EXIT_PLAN_MODE__:")) {
              const plan = event.result.slice("__EXIT_PLAN_MODE__:".length);
              // Show plan confirmation dialog
              const approved = await new Promise<boolean>((resolve) => {
                setPlanConfirm({ plan, resolve });
              });
              setPlanConfirm(null);
              if (approved) {
                setPlanMode(false);
                planModeRef.current = false;
                addSystem("計画を承認しました。プランモードを解除して実行します。");
              } else {
                addSystem("計画を拒否しました。計画の修正を促します。");
              }
            }
            const label = formatToolResult(event.name, event.result, event.isError, event.elapsed);
            setMessages((m) => [...m, {
              role: "tool_result",
              name: event.name,
              label,
              isError: event.isError,
              elapsed: event.elapsed,
            }]);
            setRunStatus("API 呼び出し中...");
          } else if (event.type === "api_retry") {
            addSystem(`API エラー（${event.reason}）— ${event.delayMs}ms 後に再試行 (${event.attempt}/${event.maxAttempts})`);
          } else if (event.type === "compaction") {
            addSystem(`[自動圧縮] コンテキストが上限の 75% を超えたため要約しました（${event.oldCount} → ${event.newCount} メッセージ）`);
          } else if (event.type === "done") {
            finalHistory = event.history;
            if (event.usage) {
              setSessionUsage((prev) => ({
                inputTokens: prev.inputTokens + event.usage!.inputTokens,
                outputTokens: prev.outputTokens + event.usage!.outputTokens,
                cacheCreationTokens: prev.cacheCreationTokens + (event.usage!.cacheCreationTokens ?? 0),
                cacheReadTokens: prev.cacheReadTokens + (event.usage!.cacheReadTokens ?? 0),
              }));
            }
            // Render markdown on all assistant messages at turn end
            setMessages((m) => m.map((msg) => {
              if (msg.role === "assistant" && !msg.rendered) {
                return { ...msg, rendered: renderMarkdown(msg.text) };
              }
              return msg;
            }));
          }
        }

        setHistory(finalHistory);
        saveSession(currentEntry.value, finalHistory);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addSystem(`エラー: ${msg}`);
      } finally {
        setRunning(false);
      }
    },
    [running, history, currentEntry, handleCommand, permissionChecker, projectContext, addSystem],
  );

  const handleModelSelect = useCallback((selectedModel: string) => {
    const entry = MODELS.find((m) => m.value === selectedModel);
    if (!entry) return;
    setSelectMode(null);
    if (!isConfigured(entry.provider)) {
      setSetupTarget({ entry, step: entry.provider === "openai-oauth" ? "oauth_wait" : "key" });
      return;
    }
    const providerChanged = entry.provider !== currentEntry.provider;
    setCurrentEntry(entry);
    if (providerChanged) {
      setHistory({ provider: entry.provider as "anthropic", messages: [] });
      addSystem(`モデル変更: ${entry.value}（履歴をリセットしました）`);
    } else {
      addSystem(`モデル変更: ${entry.value}`);
    }
  }, [currentEntry]);

  const handleSetupKey = useCallback(async (apiKey: string) => {
    if (!setupTarget) return;
    const { entry } = setupTarget;
    const config = loadConfig() ?? {};
    switch (entry.provider) {
      case "deepseek":
        config.deepseekApiKey = apiKey;
        config.defaultProvider = "deepseek";
        process.env.DEEPSEEK_API_KEY = apiKey;
        break;
      case "anthropic":
        config.anthropicApiKey = apiKey;
        config.defaultProvider = "anthropic";
        process.env.ANTHROPIC_API_KEY = apiKey;
        break;
      case "openai-api":
        config.openaiApiKey = apiKey;
        config.defaultProvider = "openai-api";
        process.env.OPENAI_API_KEY = apiKey;
        break;
      case "gemini":
        config.geminiApiKey = apiKey;
        config.defaultProvider = "gemini";
        process.env.GEMINI_API_KEY = apiKey;
        break;
    }
    saveConfig(config);
    applyConfig(config);
    const providerChanged = entry.provider !== currentEntry.provider;
    setCurrentEntry(entry);
    if (providerChanged) {
      setHistory({ provider: entry.provider as "anthropic", messages: [] });
    }
    setSetupTarget(null);
    addSystem(`✓ ${PROVIDER_LABELS[entry.provider]} を設定しました。モデル: ${entry.value}`);
  }, [setupTarget, currentEntry]);

  const handleResumeSelect = useCallback((sessionId: string) => {
    const session = listSessions().find((s) => s.id === sessionId);
    if (session) {
      setHistory(session.history);
      const entry = MODELS.find((m) => m.value === session.model) ?? getDefaultModel();
      setCurrentEntry(entry);
      setSelectMode(null);
      addSystem(`復元: ${session.savedAt.slice(0, 16).replace("T", " ")}  ${session.model}  ターン数: ${session.history.messages.length}`);
    }
  }, []);

  const cancelSelect = useCallback(() => setSelectMode(null), []);

  if (selectMode?.type === "model") {
    return (
      <Box flexDirection="column" padding={1}>
        <Selector
          title="モデルを選択"
          items={MODELS.map((m) => ({
            label: m.label,
            value: m.value,
            description: [
              `[${PROVIDER_LABELS[m.provider]}]`,
              !isConfigured(m.provider) ? "⚠ 未設定" : "",
              m.value === currentEntry.value ? "← 現在" : "",
            ].filter(Boolean).join("  "),
          }))}
          onSelect={handleModelSelect}
          onCancel={cancelSelect}
        />
      </Box>
    );
  }

  if (selectMode?.type === "resume") {
    const sessions = listSessions();
    if (sessions.length === 0) {
      setTimeout(() => { addSystem("保存済みセッションが見つかりません。"); setSelectMode(null); }, 0);
      return null;
    }
    return (
      <Box flexDirection="column" padding={1}>
        <Selector
          title="セッションを選択"
          items={sessions.map((s) => ({
            label: s.preview,
            value: s.id,
            description: `${s.savedAt.slice(0, 16).replace("T", " ")}  ${s.model}`,
          }))}
          onSelect={handleResumeSelect}
          onCancel={cancelSelect}
        />
      </Box>
    );
  }

  if (setupTarget) {
    const { entry, step } = setupTarget;
    const label = PROVIDER_LABELS[entry.provider];
    if (step === "oauth_wait") {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color="cyan">OpenAI OAuth セットアップ</Text>
          <Box marginY={1} flexDirection="column">
            <Text>ChatGPT サブスクリプション認証が必要です。</Text>
            <Text>agent を終了して <Text bold>npx @openai/codex login --device-auth</Text> を実行し、</Text>
            <Text>認証完了後に agent を再起動してください。</Text>
          </Box>
          <Text dimColor>Esc でキャンセル</Text>
        </Box>
      );
    }
    const placeholder = entry.provider === "deepseek" ? "DeepSeek API キー" :
      entry.provider === "anthropic" ? "sk-ant-..." :
      entry.provider === "openai-api" ? "sk-..." :
      "Google API キー";
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">{label} セットアップ — {entry.value}</Text>
        <Box marginY={1}>
          <Text>{label} API キー: </Text>
          <TextInput
            onSubmit={handleSetupKey}
            placeholder={placeholder}
            secret
            isActive
          />
        </Box>
        <Text dimColor>Enter で確定  Esc でキャンセル</Text>
      </Box>
    );
  }

  const providerLabel = PROVIDER_LABELS[currentEntry.provider];
  const totalTokens = sessionUsage.inputTokens + sessionUsage.outputTokens;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Text bold color="cyan">
        KodeKode [{providerLabel}:{currentEntry.value}]
        {yoloMode ? <Text color="red"> [YOLO]</Text> : null}
        {planMode ? <Text color="yellow"> [PLAN]</Text> : null}
        {running ? <Text color="yellow"> {runStatus} | Esc で中断</Text> : <Text dimColor> /help Ctrl+C</Text>}
      </Text>

      {/* Todo panel */}
      <TodoPanel todos={todos} />

      {/* Plan confirmation overlay */}
      {planConfirm && (
        <PlanConfirmDialog plan={planConfirm.plan} onDecide={planConfirm.resolve} />
      )}

      {/* Message list */}
      <Box flexDirection="column" marginY={1}>
        {messages.slice(-30).map((msg, i) => {
          const key = `msg-${i}`;
          if (msg.role === "user") return (
            <Box key={key} marginBottom={1}>
              <Text color="green" bold>You: </Text><Text>{msg.text}</Text>
            </Box>
          );
          if (msg.role === "assistant") return (
            <Box key={key} marginBottom={1} flexDirection="column">
              <Box>
                <Text color="blue" bold>Agent: </Text>
              </Box>
              <Text>{msg.rendered ?? msg.text}</Text>
            </Box>
          );
          if (msg.role === "system") return (
            <Box key={key} marginBottom={1} borderStyle="single" borderColor="gray" paddingX={1}>
              <Text dimColor>{msg.text}</Text>
            </Box>
          );
          if (msg.role === "tool_call") return (
            <Box key={key}>
              <Text color="cyan" bold>{msg.label}</Text>
            </Box>
          );
          // tool_result
          return (
            <Box key={key} marginBottom={1}>
              <Text dimColor color={msg.isError ? "red" : undefined}>{msg.label}</Text>
            </Box>
          );
        })}
      </Box>

      {/* Permission prompt overlay */}
      {pendingPermission && (
        <PermissionPrompt
          toolName={pendingPermission.toolName}
          preview={pendingPermission.preview}
          onDecide={pendingPermission.resolve}
        />
      )}

      {/* Input area */}
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor={running ? "yellow" : "gray"}>
          {running
            ? <Text color="yellow"> {runStatus} </Text>
            : <TextInput onSubmit={handleSubmit} placeholder="タスクを入力... (/help  # メモ  ! シェル)" isActive={!running} history={inputHistory} />
          }
        </Box>
        {/* Status bar */}
        {totalTokens > 0 && (
          <Box>
            <Text dimColor>
              {" "}↑ {(sessionUsage.inputTokens / 1000).toFixed(1)}k ↓ {(sessionUsage.outputTokens / 1000).toFixed(1)}k tokens
              {(sessionUsage.cacheReadTokens > 0) ? ` 💾 ${(sessionUsage.cacheReadTokens / 1000).toFixed(1)}k cached` : ""}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
