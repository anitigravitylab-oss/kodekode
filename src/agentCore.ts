/**
 * agentCore.ts — shared utilities for all 3 SDK agents (Anthropic/OpenAI/Gemini)
 *
 * Pure functions / classes. No SDK-specific imports.
 * INV-5: All I/O waits use withTimeout. INV-6: Errors classified before propagation.
 */
import { appendFileSync } from "fs";
import { ALL_TOOLS } from "./tools/index.js";
import type { AgentEvent, PermissionDecision } from "./types.js";

// ─── Logging (INV-5) ──────────────────────────────────────────────────────────

/** Append one log line: `[HH:MM:SS.mmm] [provider] msg` */
export function dbg(provider: string, msg: string): void {
  const t = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  appendFileSync("/tmp/kodekode.log", `[${t}] [${provider}] ${msg}\n`);
}

// ─── Signal / Timeout (INV-2, INV-4) ─────────────────────────────────────────

/**
 * Combine userSignal + per-call timeout into one callSignal.
 * Also returns the raw timeoutSignal so callers can distinguish timeout from user-abort.
 */
export function makeCallSignal(
  userSignal: AbortSignal | undefined,
  timeoutMs = 60_000,
): { callSignal: AbortSignal; timeoutSignal: AbortSignal } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callSignal = userSignal
    ? AbortSignal.any([userSignal, timeoutSignal])
    : timeoutSignal;
  return { callSignal, timeoutSignal };
}

/** Wrap a promise with a timeout. Rejects with an Error if ms elapses. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`タイムアウト（${ms / 1000}秒）: ${label}`)),
        ms,
      ),
    ),
  ]);
}

// ─── Error classification (INV-6) ────────────────────────────────────────────

export type ErrorClass =
  | { kind: "user_abort" }
  | { kind: "timeout" }
  | { kind: "retryable_api"; status?: number; reason: string }
  | { kind: "fatal_api"; status?: number; message: string }
  | { kind: "other"; message: string };

export function classifyError(err: unknown, timeoutSignal?: AbortSignal): ErrorClass {
  const e = err as Error & { status?: number; name?: string };
  const name = e?.name ?? "";
  const status = e?.status;
  const message = e?.message ?? String(err);

  // User explicitly aborted
  if (name === "APIUserAbortError") return { kind: "user_abort" };
  // AbortError that is NOT from timeoutSignal → user abort
  if (name === "AbortError" && !(timeoutSignal?.aborted)) return { kind: "user_abort" };

  // Timeout (from our timer, not user)
  if (name === "TimeoutError" || (name === "AbortError" && timeoutSignal?.aborted)) {
    return { kind: "timeout" };
  }

  // Retryable: 5xx, 408+, 429, 529, connection errors
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") {
    return { kind: "retryable_api", reason: name };
  }
  if (status !== undefined && (status === 429 || status === 529 || status >= 500 || status === 408)) {
    return { kind: "retryable_api", status, reason: `HTTP ${status}` };
  }

  // Non-retryable API errors (4xx auth / bad request)
  if (status !== undefined && status >= 400 && status < 500) {
    return { kind: "fatal_api", status, message };
  }

  return { kind: "other", message };
}

/** Returns true when we should retry the API call. */
export function isRetryable(err: unknown, userSignal?: AbortSignal): boolean {
  if (userSignal?.aborted) return false;
  const cls = classifyError(err);
  return cls.kind === "retryable_api" || cls.kind === "timeout";
}

// ─── Retry wrapper (INV-6) ────────────────────────────────────────────────────

export interface RetryOpts {
  maxAttempts: number;   // recommended: 3
  baseDelayMs: number;   // recommended: 1000  (1s → 2s → 4s)
  userSignal?: AbortSignal;
}

/**
 * Generator-aware retry wrapper.
 * - Forwards all yielded events from each attempt.
 * - On throw: classifies, yields api_retry event, waits, retries.
 * - Exhausted retries / non-retryable → re-throws.
 */
export async function* withRetry<T>(
  attemptFn: (attempt: number) => AsyncGenerator<AgentEvent, T>,
  opts: RetryOpts,
): AsyncGenerator<AgentEvent, T> {
  const { maxAttempts, baseDelayMs, userSignal } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const gen = attemptFn(attempt);
      // Forward all events
      let result = await gen.next();
      while (!result.done) {
        yield result.value;
        result = await gen.next();
      }
      return result.value as T;
    } catch (err) {
      const lastAttempt = attempt >= maxAttempts;
      if (lastAttempt || !isRetryable(err, userSignal)) {
        throw err;
      }
      if (userSignal?.aborted) throw err;

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      const cls = classifyError(err);
      const reason = cls.kind === "retryable_api" ? cls.reason
        : cls.kind === "timeout" ? "timeout"
        : "unknown";

      yield {
        type: "api_retry",
        attempt,
        maxAttempts,
        delayMs,
        reason,
      };

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        if (userSignal) {
          userSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("User aborted during retry delay"));
          }, { once: true });
        }
      });
    }
  }

  // Should never reach here
  throw new Error("withRetry: exhausted all attempts");
}

// ─── Consecutive failure tracker (INV-6) ─────────────────────────────────────

export class FailureTracker {
  private readonly counts = new Map<string, number>();

  recordSuccess(toolName: string): void {
    this.counts.delete(toolName);
  }

  recordFailure(toolName: string): number {
    const next = (this.counts.get(toolName) ?? 0) + 1;
    this.counts.set(toolName, next);
    return next;
  }

  getHint(toolName: string): string | null {
    const count = this.counts.get(toolName) ?? 0;
    if (count < 3) return null;
    const hints: Record<string, string> = {
      bash:      "bash が連続失敗しています。grep / read_file など別ツールを検討してください",
      read_file: "read_file が連続失敗。glob でファイル存在を先に確認してください",
      web_fetch: "web_fetch が連続失敗。URL が正しいか、web_search で代替検索を検討してください",
    };
    return hints[toolName] ?? "同じツールが連続で失敗しています。別の手段を検討してください";
  }
}

// ─── Tool execution (INV-1, INV-3, INV-6) ────────────────────────────────────

export interface NeutralToolCall {
  id: string;      // SDK-specific ID for history stitching
  name: string;
  input: unknown;
}

export interface ToolExecResult {
  id: string;
  text: string;
  isError: boolean;
  elapsed: number;
}

export type PermissionChecker = (toolName: string, preview: string) => Promise<PermissionDecision>;

const MAX_TOOL_OUTPUT = 20_000;
function truncate(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return text.slice(0, MAX_TOOL_OUTPUT) + `\n…(${text.length - MAX_TOOL_OUTPUT} 文字省略)`;
}

/**
 * Execute all tool calls in order.
 * Yields tool_use / tool_result events; returns array of ToolExecResult.
 * Never throws — errors are captured as isError results.
 */
export async function* executeTools(
  calls: NeutralToolCall[],
  context: { cwd: string },
  permissionChecker: PermissionChecker | undefined,
  signal: AbortSignal | undefined,
  tracker: FailureTracker,
): AsyncGenerator<AgentEvent, ToolExecResult[]> {
  const results: ToolExecResult[] = [];

  for (const call of calls) {
    if (signal?.aborted) break;

    const startTime = Date.now();
    yield { type: "tool_use", name: call.name, input: call.input, startTime };

    const tool = ALL_TOOLS.find((t) => t.name === call.name);
    let resultText: string;
    let isError = false;

    if (!tool) {
      resultText = `Unknown tool: ${call.name}`;
      isError = true;
    } else {
      // Permission check for write tools
      if (!tool.isReadOnly && permissionChecker) {
        const preview =
          call.name === "bash"
            ? `$ ${((call.input as { command?: string }).command ?? "").slice(0, 120)}`
            : `${call.name}(${JSON.stringify(call.input).slice(0, 120)})`;
        const decision = await permissionChecker(call.name, preview);
        if (decision === "deny") {
          resultText = "ユーザーにより実行を拒否されました。";
          isError = true;
          const elapsed = Date.now() - startTime;
          yield { type: "tool_result", name: call.name, result: resultText, isError, elapsed };
          results.push({ id: call.id, text: resultText, isError, elapsed });
          continue;
        }
      }

      try {
        const toolResult = await tool.call(call.input as never, { ...context, abortSignal: signal });
        resultText = truncate(toolResult.text);
        isError = toolResult.type === "error";
      } catch (err) {
        resultText = `ツール実行エラー: ${(err as Error)?.message ?? String(err)}`;
        isError = true;
      }
    }

    // Track failures and append hints
    if (isError) {
      tracker.recordFailure(call.name);
      const hint = tracker.getHint(call.name);
      if (hint) resultText += `\n\n[ヒント: ${hint}]`;
    } else {
      tracker.recordSuccess(call.name);
    }

    const elapsed = Date.now() - startTime;
    yield { type: "tool_result", name: call.name, result: resultText, isError, elapsed };
    results.push({ id: call.id, text: resultText, isError, elapsed });
  }

  return results;
}
