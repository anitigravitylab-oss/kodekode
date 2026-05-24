import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

export type ProviderType = "deepseek" | "anthropic" | "openai-oauth" | "openai-api" | "gemini";

export type AgentEvent =
  | { type: "text_delta"; text: string }     // streaming chunk — append to current assistant bubble
  | { type: "thinking_delta"; text: string } // thinking block delta (for reasoning models)
  | { type: "text"; text: string }           // complete text (non-streaming providers)
  | { type: "tool_use"; name: string; input: unknown; startTime: number }
  | { type: "tool_result"; name: string; result: string; isError: boolean; elapsed: number }
  | { type: "compaction"; oldCount: number; newCount: number }
  | { type: "api_retry"; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: "done"; history: History; usage?: { inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number } };

export type AnthropicHistory = { provider: "anthropic" | "deepseek"; messages: Anthropic.MessageParam[] };
export type OpenAIHistory    = { provider: "openai-oauth" | "openai-api"; messages: OpenAI.ChatCompletionMessageParam[] };

export type GeminiPart =
  | { text: string }
  | { thought: string; thoughtSignature?: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };
export type GeminiContent = { role: string; parts: GeminiPart[] };
export type GeminiHistory   = { provider: "gemini"; messages: GeminiContent[] };

export type History = AnthropicHistory | OpenAIHistory | GeminiHistory;

// Permission system
export type PermissionDecision = "allow_once" | "always" | "deny";

export type PermissionRequest = {
  toolName: string;
  preview: string;
  resolve: (decision: PermissionDecision) => void;
};
