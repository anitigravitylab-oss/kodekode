import { GoogleGenAI } from "@google/genai";
import { ALL_TOOLS } from "./tools/index.js";
import type { AgentEvent, GeminiContent } from "./types.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { setAgentSpawner } from "./tools/TaskTool.js";
import { runAgent } from "./agent.js";
import {
  dbg,
  makeCallSignal,
  withTimeout,
  FailureTracker,
  executeTools,
  classifyError,
  isRetryable,
  type NeutralToolCall,
} from "./agentCore.js";

export type { AgentEvent };

const sharedContext = { cwd: process.cwd() };
const context = sharedContext;

export async function* runGeminiAgent(
  messages: GeminiContent[],
  model: string,
  apiKey: string,
  signal?: AbortSignal,
  subagent?: { model: string; apiKey: string; baseURL: string },
): AsyncGenerator<AgentEvent> {
  const genAI = new GoogleGenAI({ apiKey });
  const tracker = new FailureTracker();

  // Register sub-agent spawner
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

  const history: GeminiContent[] = [...messages];

  while (true) {
    if (signal?.aborted) break;

    // ── API call with retry (INV-6) ──────────────────────────────────────────
    let attempt = 0;
    const maxAttempts = 3;
    const baseDelayMs = 1000;
    interface Candidate {
      content: { parts: Array<Record<string, unknown>> };
      finishReason?: string;
    }
    let finalCandidate: Candidate | null = null;
    let turnSucceeded = false;

    while (attempt < maxAttempts) {
      attempt++;
      dbg("gemini", `turn start: model=${model} attempt=${attempt}`);

      // Fresh signal per attempt (INV-4)
      const { callSignal: attemptSignal, timeoutSignal: attemptTimeout } = makeCallSignal(signal, 60_000);

      try {
        // New SDK: generateContentStream returns Promise<AsyncGenerator>
        const streamResponse = await genAI.models.generateContentStream({
          model,
          contents: history as never,
          config: {
            tools: [{ functionDeclarations: ALL_TOOLS.map((t) => t.toGeminiTool()) } as never],
            systemInstruction: buildSystemPrompt(),
            // Disable thinking to avoid thought_signature requirement on functionCall parts
            generationConfig: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } as never,
            abortSignal: attemptSignal,
          } as never,
        });

        let chunkCount = 0;
        const allParts: Array<any> = [];
        let lastFinishReason: string | undefined;

        try {
          for await (const chunk of streamResponse) {
            if (attemptSignal.aborted) { dbg("gemini", "callSignal aborted → break"); break; }
            chunkCount++;
            const candidate = chunk.candidates?.[0];
            if (candidate) {
              if (candidate.finishReason) lastFinishReason = candidate.finishReason;
              for (const part of candidate.content?.parts ?? []) {
                allParts.push(part);
                if ("text" in part && part.text) {
                  yield { type: "text_delta", text: part.text };
                }
                // thought parts — yield as thinking_delta
                if ("thought" in part && (part as any).thought) {
                  yield { type: "thinking_delta", text: (part as any).thought };
                }
                // functionCall parts in stream are intentionally ignored (INV-3):
                // we only use the final response for function call extraction
              }
            }
          }
          dbg("gemini", `stream done: chunkCount=${chunkCount}`);
        } catch (streamErr) {
          dbg("gemini", `stream threw: ${(streamErr as Error)?.name}: ${(streamErr as Error)?.message?.slice(0, 80)}`);
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
            dbg("gemini", `timeout → retry in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
            yield { type: "api_retry", attempt, maxAttempts, delayMs, reason: "timeout" };
            await new Promise<void>((r) => setTimeout(r, delayMs));
            continue;
          }
          throw new Error("API タイムアウト（60秒）。");
        }

        // INV-3: Build final candidate from accumulated parts
        finalCandidate = {
          content: { parts: allParts },
          finishReason: lastFinishReason,
        };
        turnSucceeded = true;
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

    if (!turnSucceeded || signal?.aborted) break;

    if (!finalCandidate) {
      dbg("gemini", "no candidate in finalResponse → done");
      yield { type: "done", history: { provider: "gemini", messages: history }, usage: undefined };
      return;
    }

    // INV-3: Extract function calls from final accumulated parts
    // New SDK preserves thoughtSignature, so no workaround needed.
    const rawParts = finalCandidate.content.parts as GeminiContent["parts"];
    const allFunctionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const filteredParts: GeminiContent["parts"] = [];
    for (const part of rawParts) {
      if ("functionCall" in part && part.functionCall) {
        allFunctionCalls.push({
          name: part.functionCall.name,
          args: part.functionCall.args as Record<string, unknown>,
        });
        filteredParts.push(part);
      } else {
        filteredParts.push(part);
      }
    }

    const modelContent: GeminiContent = {
      role: "model",
      parts: filteredParts,
    };
    history.push(modelContent);

    // INV-1: Exit when no function calls
    if (allFunctionCalls.length === 0) {
      dbg("gemini", "no function calls → done");
      yield { type: "done", history: { provider: "gemini", messages: history }, usage: undefined };
      return;
    }

    dbg("gemini", `function_calls count: ${allFunctionCalls.length}`);

    // Execute tools using agentCore (INV-6)
    const calls: NeutralToolCall[] = allFunctionCalls.map((fc, i) => ({
      // Gemini doesn't provide tool-call IDs — synthesize them
      id: `gemini_call_${i}`,
      name: fc.name,
      input: fc.args,
    }));

    const functionResponseParts: GeminiContent["parts"] = [];
    const execResults = yield* executeTools(calls, context, undefined, signal, tracker);
    for (let i = 0; i < execResults.length; i++) {
      const r = execResults[i]!;
      const fc = allFunctionCalls[i]!;
      functionResponseParts.push({
        functionResponse: { name: fc.name, response: { result: r.text } },
      });
    }

    history.push({ role: "user", parts: functionResponseParts });
  }

  yield { type: "done", history: { provider: "gemini", messages: history }, usage: undefined };
}
