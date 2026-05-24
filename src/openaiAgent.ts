import OpenAI from "openai";
import { spawn, type ChildProcess } from "child_process";
import { ALL_TOOLS } from "./tools/index.js";
import type { AgentEvent } from "./types.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { setAgentSpawner } from "./tools/TaskTool.js";
import { runAgent } from "./agent.js";
import {
  dbg,
  makeCallSignal,
  FailureTracker,
  executeTools,
  classifyError,
  isRetryable,
  type NeutralToolCall,
} from "./agentCore.js";

export type { AgentEvent };

const PROXY_PORTS = [10531, 10532, 10533];
let proxyBaseURL = `http://127.0.0.1:${PROXY_PORTS[0]}/v1`;

let proxyClient: OpenAI | null = null;
function getProxyClient() {
  if (!proxyClient) proxyClient = new OpenAI({ baseURL: proxyBaseURL, apiKey: "oauth" });
  return proxyClient;
}
function getApiClient(apiKey: string) {
  return new OpenAI({ apiKey });
}

const sharedContext = { cwd: process.cwd() };
const context = sharedContext;
let proxyProcess: ChildProcess | null = null;

async function findRunningProxy(): Promise<string | null> {
  for (const port of PROXY_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      if (res.ok) return `http://127.0.0.1:${port}/v1`;
    } catch {}
  }
  return null;
}

export async function ensureProxy(): Promise<"ready" | "started" | "login_required"> {
  const existing = await findRunningProxy();
  if (existing) {
    proxyBaseURL = existing;
    proxyClient = null;
    return "ready";
  }

  proxyProcess = spawn("npx", ["openai-oauth"], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: false,
  });

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 8000);
    proxyProcess!.stdout?.on("data", (data: Buffer) => {
      const line = data.toString();
      const match = line.match(/endpoint ready at (http:\/\/127\.0\.0\.1:\d+\/v1)/);
      if (match?.[1]) {
        proxyBaseURL = match[1];
        proxyClient = null;
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const found = await findRunningProxy();
  if (found) {
    proxyBaseURL = found;
    proxyClient = null;
    return "started";
  }

  proxyProcess.kill();
  proxyProcess = null;
  proxyClient = null;
  return "login_required";
}

process.on("exit", () => { proxyProcess?.kill(); });
process.on("SIGINT", () => { proxyProcess?.kill(); });

export async function* runOpenAIAgent(
  messages: OpenAI.ChatCompletionMessageParam[],
  model: string,
  apiKey?: string,
  signal?: AbortSignal,
  subagent?: { model: string; apiKey: string; baseURL: string },
): AsyncGenerator<AgentEvent> {
  const history: OpenAI.ChatCompletionMessageParam[] = [...messages];
  const tools = ALL_TOOLS.map((t) => t.toOpenAITool());
  const client = apiKey ? getApiClient(apiKey) : getProxyClient();
  const providerKey = apiKey ? "openai-api" as const : "openai-oauth" as const;
  const tracker = new FailureTracker();

  // Register sub-agent spawner (uses DeepSeek Flash or configured subagent model)
  if (subagent) {
    setAgentSpawner(async (prompt: string, systemSuffix: string): Promise<string> => {
      const subMessages = [{ role: "user" as const, content: prompt }];
      let lastText = "";
      for await (const event of runAgent(subMessages, subagent.model, {
        apiKey: subagent.apiKey,
        baseURL: subagent.baseURL,
        signal,
        isSubagent: true,
        promptOpts: { systemSuffix },
      })) {
        if (event.type === "text_delta" || event.type === "text") {
          lastText += event.text;
        }
      }
      return lastText || "(サブエージェントから応答なし)";
    });
  }

  while (true) {
    if (signal?.aborted) break;

    // ── API call with retry (INV-6) ──────────────────────────────────────────
    let contentText = "";
    let toolCallsList: Array<{ id: string; name: string; args: string }> = [];
    let attempt = 0;
    const maxAttempts = 3;
    const baseDelayMs = 1000;
    let succeeded = false;

    while (attempt < maxAttempts) {
      attempt++;
      dbg("openai", `turn start: model=${model} attempt=${attempt}`);

      // Fresh signal per attempt (INV-4)
      const { callSignal: attemptSignal, timeoutSignal: attemptTimeout } = makeCallSignal(signal, 60_000);

      contentText = "";
      const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();

      try {
        const stream = await client.chat.completions.create({
          model,
          max_tokens: 8096,
          tools,
          stream: true,
          messages: [
            { role: "system", content: buildSystemPrompt() },
            ...history,
          ],
        }, { signal: attemptSignal });

        try {
          for await (const chunk of stream) {
            if (attemptSignal.aborted) { dbg("openai", "callSignal aborted → break"); break; }
            const choice = chunk.choices[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (delta?.content) {
              contentText += delta.content;
              yield { type: "text_delta", text: delta.content };
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = toolCallsMap.get(tc.index) ?? { id: "", name: "", args: "" };
                toolCallsMap.set(tc.index, {
                  // INV-3: prefer the first non-empty id we see for each index
                  id: existing.id || tc.id || "",
                  name: existing.name || tc.function?.name || "",
                  args: existing.args + (tc.function?.arguments ?? ""),
                });
              }
            }
            // finish_reason is informational only — not used for continuation (INV-1)
          }
          dbg("openai", "for-await loop exited naturally");
        } catch (streamErr) {
          dbg("openai", `for-await threw: ${(streamErr as Error)?.name}: ${(streamErr as Error)?.message?.slice(0, 80)}`);
          const cls = classifyError(streamErr, attemptTimeout);
          if (cls.kind === "user_abort") throw streamErr;
          if (isRetryable(streamErr, signal) && attempt < maxAttempts) {
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

        if (signal?.aborted) throw new Error("User aborted");
        if (attemptTimeout.aborted) {
          if (!signal?.aborted && attempt < maxAttempts) {
            const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
            dbg("openai", `timeout → retry in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
            yield { type: "api_retry", attempt, maxAttempts, delayMs, reason: "timeout" };
            await new Promise<void>((r) => setTimeout(r, delayMs));
            continue;
          }
          throw new Error("API タイムアウト（60秒）。");
        }

        // Reconstruct tool calls list — fix id补充 (INV-3): existing.id first
        toolCallsList = [...toolCallsMap.entries()]
          .sort(([a], [b]) => a - b)
          .map(([i, tc]) => ({
            id: tc.id || `call_${i}`,
            name: tc.name,
            args: tc.args,
          }));

        dbg("openai", `for-await loop exited: toolCallsList=${toolCallsList.length}`);
        succeeded = true;
        break; // success

      } catch (outerErr) {
        if ((outerErr as Error)?.message === "User aborted") throw outerErr;
        if (isRetryable(outerErr, signal) && attempt < maxAttempts) {
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

    if (!succeeded || signal?.aborted) break;

    // Build assistant message and push to history
    const assistantMsg: OpenAI.ChatCompletionMessageParam = {
      role: "assistant",
      content: contentText || null,
      ...(toolCallsList.length > 0 ? {
        tool_calls: toolCallsList.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        })),
      } : {}),
    };
    history.push(assistantMsg);

    // INV-1: Continuation decided solely by presence of tool calls (finish_reason ignored)
    if (toolCallsList.length === 0) {
      dbg("openai", "no tool calls → done");
      yield { type: "done", history: { provider: providerKey, messages: history }, usage: undefined };
      return;
    }

    dbg("openai", `tool_calls count: ${toolCallsList.length}`);

    // Execute tools using agentCore (INV-6)
    const calls: NeutralToolCall[] = [];
    const parseErrors: Array<{ id: string; name: string; error: string }> = [];

    for (const tc of toolCallsList) {
      // JSON.parse in try-catch (INV-6: errors don't kill the loop)
      let input: unknown;
      try {
        input = JSON.parse(tc.args) as unknown;
        calls.push({ id: tc.id, name: tc.name, input });
      } catch (parseErr) {
        dbg("openai", `JSON.parse failed for ${tc.name}: ${(parseErr as Error)?.message}`);
        parseErrors.push({ id: tc.id, name: tc.name, error: (parseErr as Error)?.message ?? "JSON parse error" });
      }
    }

    // Emit parse errors as tool_use + tool_result events and add to history
    for (const pe of parseErrors) {
      const startTime = Date.now();
      yield { type: "tool_use", name: pe.name, input: {}, startTime };
      const resultText = `ツール引数のJSONパースに失敗: ${pe.error}`;
      const elapsed = Date.now() - startTime;
      yield { type: "tool_result", name: pe.name, result: resultText, isError: true, elapsed };
      history.push({ role: "tool", tool_call_id: pe.id, content: resultText });
    }

    // Execute valid tool calls
    if (calls.length > 0) {
      const execResults = yield* executeTools(calls, context, undefined, signal, tracker);
      for (const r of execResults) {
        history.push({ role: "tool", tool_call_id: r.id, content: r.text });
      }
    }
  }

  yield { type: "done", history: { provider: providerKey, messages: history }, usage: undefined };
}
