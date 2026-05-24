import Anthropic from "@anthropic-ai/sdk";
import { ALL_TOOLS } from "./tools/index.js";
import type { AgentEvent, History, PermissionDecision } from "./types.js";
import { buildSystemPrompt, type SystemPromptOptions } from "./systemPrompt.js";
import { setAgentSpawner } from "./tools/TaskTool.js";
import {
  dbg,
  makeCallSignal,
  FailureTracker,
  executeTools,
  classifyError,
  isRetryable,
  type NeutralToolCall,
  type PermissionChecker as CorePermissionChecker,
} from "./agentCore.js";

// Context window limits (tokens) per model family
const MODEL_CONTEXT_LIMIT: Record<string, number> = {
  "claude":      200_000,
  "deepseek":  1_000_000,
  "gpt-5":       400_000,
  "gemini":    1_000_000,
  "default":   200_000,
};

function getContextLimit(model: string): number {
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMIT)) {
    if (model.startsWith(key)) return limit;
  }
  return MODEL_CONTEXT_LIMIT["default"]!;
}

/** Rough token estimate: chars / 4 */
function estimateTokens(messages: Anthropic.MessageParam[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if ("text" in block && typeof block.text === "string") chars += block.text.length;
        if ("content" in block && typeof block.content === "string") chars += block.content.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

const sharedContext = { cwd: process.cwd() };

export type PermissionChecker = (
  toolName: string,
  preview: string,
) => Promise<PermissionDecision>;

export async function* runAgent(
  messages: Anthropic.MessageParam[],
  model: string,
  opts: {
    apiKey: string;
    baseURL?: string;
    signal?: AbortSignal;
    permissionChecker?: PermissionChecker;
    promptOpts?: SystemPromptOptions;
    /** If true, is a sub-agent — skip auto-compaction and permission checks */
    isSubagent?: boolean;
    /** サブエージェント専用モデル（未設定時はメインモデルと同じ） */
    subagentModel?: string;
    /** サブエージェント専用 API キー */
    subagentApiKey?: string;
    /** サブエージェント専用 baseURL */
    subagentBaseURL?: string;
  },
): AsyncGenerator<AgentEvent> {
  const providerTag = (opts.baseURL ?? "").includes("deepseek") ? "deepseek" : "anthropic";
  const isDeepSeek = providerTag === "deepseek";
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  const history = [...messages];
  const context = { ...sharedContext };
  const systemPrompt = buildSystemPrompt(opts.promptOpts ?? {});
  const contextLimit = getContextLimit(model);
  const tracker = new FailureTracker();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  // Build tool list with optional cache_control on last tool (Anthropic only)
  const rawTools = ALL_TOOLS.map((t) => t.toAnthropicTool());
  function buildTools(withCache: boolean): Anthropic.Tool[] {
    if (!withCache || isDeepSeek) return rawTools as Anthropic.Tool[];
    const tools = rawTools.map((t) => ({ ...t })) as Anthropic.Tool[];
    if (tools.length > 0) {
      (tools[tools.length - 1] as unknown as Record<string, unknown>)["cache_control"] = { type: "ephemeral" };
    }
    return tools;
  }

  // Build system as cacheable block (Anthropic only)
  function buildSystem(withCache: boolean): Anthropic.TextBlockParam[] | string {
    if (!withCache || isDeepSeek) return systemPrompt;
    return [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
  }

  // Register sub-agent spawner
  if (!opts.isSubagent) {
    setAgentSpawner(async (prompt: string, systemSuffix: string): Promise<string> => {
      const subMessages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
      const subModel = opts.subagentModel ?? model;
      const subApiKey = opts.subagentApiKey ?? opts.apiKey;
      const subBaseURL = opts.subagentBaseURL ?? opts.baseURL;
      const subOpts = {
        apiKey: subApiKey,
        baseURL: subBaseURL,
        signal: opts.signal,
        isSubagent: true,
        promptOpts: { systemSuffix },
      };
      let lastText = "";
      for await (const event of runAgent(subMessages, subModel, subOpts)) {
        if (event.type === "text_delta" || event.type === "text") {
          lastText += event.text;
        }
      }
      return lastText || "(サブエージェントから応答なし)";
    });
  }

  // Plan-mode + subagent-aware permission checker
  const corePermissionChecker: CorePermissionChecker | undefined =
    opts.permissionChecker && !opts.isSubagent
      ? async (toolName: string, preview: string) => {
          return (opts.permissionChecker as PermissionChecker)(toolName, preview);
        }
      : undefined;

  /** Yield done and return */
  function* makeDone(h: Anthropic.MessageParam[]): Generator<AgentEvent> {
    yield {
      type: "done",
      history: { provider: providerTag === "deepseek" ? "deepseek" : "anthropic", messages: h },
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheCreationTokens, cacheReadTokens },
    };
  }

  while (true) {
    if (opts.signal?.aborted) break;

    // ── Auto-compaction ──────────────────────────────────────────────────────
    if (!opts.isSubagent && history.length > 4) {
      const estimated = estimateTokens(history);
      const threshold = Math.floor(contextLimit * 0.75);
      if (estimated > threshold) {
        dbg(providerTag, `compaction triggered: estimated=${estimated} threshold=${threshold}`);
        const half = Math.floor(history.length / 2);
        const toSummarize = history.splice(0, half);
        const oldCount = half;

        try {
          const summaryText = toSummarize
            .map((m) => {
              const role = m.role;
              const text = typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content).slice(0, 500);
              return `${role}: ${text}`;
            })
            .join("\n")
            .slice(0, 6000);

          const summaryRes = await client.messages.create({
            model,
            max_tokens: 400,
            messages: [
              {
                role: "user",
                content: `以下の会話を300文字以内で要約してください。重要な決定や変更内容を含めてください:\n\n${summaryText}`,
              },
            ],
          });
          const summaryContent = summaryRes.content[0];
          const summaryStr = summaryContent?.type === "text" ? summaryContent.text : "(要約失敗)";

          history.unshift({ role: "user", content: `[圧縮済み: 過去のやりとり要約: ${summaryStr}]` });
          history.unshift({ role: "assistant", content: "了解しました。" });

          const newCount = history.length;
          yield { type: "compaction", oldCount, newCount };
          dbg(providerTag, `compaction done: ${oldCount} → ${newCount}`);
        } catch (err) {
          dbg(providerTag, `compaction summary failed: ${(err as Error)?.message}`);
          const newCount = history.length;
          yield { type: "compaction", oldCount, newCount };
        }
      }
    }

    // ── API call with retry (INV-6) ──────────────────────────────────────────
    let response: Anthropic.Message | null = null;
    let attempt = 0;
    const maxAttempts = 3;
    const baseDelayMs = 1000;

    while (attempt < maxAttempts) {
      attempt++;
      dbg(providerTag, `turn start: model=${model} attempt=${attempt}`);

      const useCache = !isDeepSeek;
      // Fresh signal per attempt so timeout resets (INV-4)
      const { callSignal: attemptSignal, timeoutSignal: attemptTimeout } = makeCallSignal(opts.signal, 60_000);

      try {
        const stream = client.messages.stream(
          {
            model,
            max_tokens: 8096,
            tools: buildTools(useCache),
            messages: history,
            system: buildSystem(useCache) as never,
          },
          { signal: attemptSignal },
        );

        try {
          for await (const event of stream) {
            if (attemptSignal.aborted) { dbg(providerTag, "callSignal aborted → break"); break; }
            if (event.type === "message_stop") { dbg(providerTag, "message_stop → break"); break; }
            if (event.type === "content_block_start") dbg(providerTag, `block_start: ${event.content_block.type}`);
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              yield { type: "text_delta", text: event.delta.text };
            }
            if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
              yield { type: "thinking_delta", text: event.delta.thinking };
            }
          }
          dbg(providerTag, "for-await loop exited normally");
        } catch (streamErr) {
          dbg(providerTag, `for-await threw: ${(streamErr as Error)?.name}: ${(streamErr as Error)?.message?.slice(0, 80)}`);
          const cls = classifyError(streamErr, attemptTimeout);
          if (cls.kind === "user_abort") throw streamErr; // propagate immediately
          if (isRetryable(streamErr, opts.signal) && attempt < maxAttempts) {
            const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
            const reason = cls.kind === "timeout" ? "timeout"
              : cls.kind === "retryable_api" ? cls.reason : "api_error";
            yield { type: "api_retry", attempt, maxAttempts, delayMs, reason };
            await new Promise<void>((r) => setTimeout(r, delayMs));
            continue;
          }
          if (cls.kind === "timeout") throw new Error("API タイムアウト（60秒）。ネットワークまたは API 障害の可能性があります。");
          throw streamErr;
        }

        if (opts.signal?.aborted) throw new Error("User aborted");
        if (attemptTimeout.aborted) {
          if (!opts.signal?.aborted && attempt < maxAttempts) {
            const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
            dbg(providerTag, `timeout → retry in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
            yield { type: "api_retry", attempt, maxAttempts, delayMs, reason: "timeout" };
            await new Promise<void>((r) => setTimeout(r, delayMs));
            continue;
          }
          throw new Error("API タイムアウト（60秒）。");
        }

        // INV-3: use final snapshot, not stream deltas
        const msg = stream.currentMessage;
        dbg(providerTag, `currentMessage: stop_reason=${msg?.stop_reason} content=${msg?.content.map((b) => b.type).join(",")}`);
        if (!msg) throw new Error("モデルから応答がありませんでした。");

        response = msg;
        break; // success

      } catch (outerErr) {
        if ((outerErr as Error)?.message === "User aborted") throw outerErr;
        if (isRetryable(outerErr, opts.signal) && attempt < maxAttempts) {
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
          const cls = classifyError(outerErr);
          const reason = cls.kind === "retryable_api" ? cls.reason
            : cls.kind === "timeout" ? "timeout" : "api_error";
          yield { type: "api_retry", attempt, maxAttempts, delayMs, reason };
          await new Promise<void>((r) => setTimeout(r, delayMs));
          continue;
        }
        throw outerErr;
      }
    }

    if (opts.signal?.aborted) { dbg(providerTag, "opts.signal aborted → outer break"); break; }
    if (!response) break; // exhausted retries without throwing

    // Track token usage
    if (response.usage) {
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      const u = response.usage as unknown as Record<string, number>;
      if (u["cache_creation_input_tokens"]) cacheCreationTokens += u["cache_creation_input_tokens"];
      if (u["cache_read_input_tokens"]) cacheReadTokens += u["cache_read_input_tokens"];
    }

    history.push({ role: "assistant", content: response.content });

    // INV-1: Continuation decided solely by presence of tool calls — stop_reason is aux info only
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    dbg(providerTag, `stop_reason=${response.stop_reason} (aux) toolUseBlocks=${toolUseBlocks.length}`);

    if (toolUseBlocks.length > 0) {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        if (opts.signal?.aborted) break;

        const startTime = Date.now();

        // Plan mode: block write operations (except exit_plan_mode)
        if (opts.promptOpts?.planMode && block.name !== "exit_plan_mode") {
          const tool = ALL_TOOLS.find((t) => t.name === block.name);
          if (tool && !tool.isReadOnly) {
            const resultText = "Plan モード中は書き込みツールは実行できません。exit_plan_mode を呼んで計画を提示してください。";
            const elapsed = Date.now() - startTime;
            dbg(providerTag, `tool_use (plan-blocked): ${block.name}`);
            yield { type: "tool_use", name: block.name, input: block.input, startTime };
            yield { type: "tool_result", name: block.name, result: resultText, isError: true, elapsed };
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText, is_error: true });
            continue;
          }
        }

        // executeTools handles permission check, tool lookup, failure tracking (INV-6)
        const neutralCall: NeutralToolCall = { id: block.id, name: block.name, input: block.input };
        dbg(providerTag, `tool_use: ${block.name}`);
        const execResults = yield* executeTools([neutralCall], context, corePermissionChecker, opts.signal, tracker);
        for (const r of execResults) {
          toolResults.push({ type: "tool_result", tool_use_id: r.id, content: r.text, is_error: r.isError });
        }
      }

      history.push({ role: "user", content: toolResults });
    }

    // INV-1: Exit only when no tool calls were returned
    if (toolUseBlocks.length === 0) {
      yield* makeDone(history);
      return;
    }
  }

  // Aborted path
  yield* makeDone(history);
}

export type { AgentEvent, History };
