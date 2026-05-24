import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages.js";
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType } from "zod";

export type ToolContext = {
  cwd: string;
  abortSignal?: AbortSignal;
};

export type ToolResult =
  | { type: "text"; text: string }
  | { type: "error"; text: string };

export type ToolDef<Input> = {
  name: string;
  description: string;
  inputSchema: ZodType<Input>;
  isReadOnly?: boolean;
  call(input: Input, context: ToolContext): Promise<ToolResult>;
};

export type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type Tool<Input = unknown> = ToolDef<Input> & {
  toAnthropicTool(): AnthropicTool;
  toOpenAITool(): OpenAITool;
  toGeminiTool(): GeminiFunctionDeclaration;
};

// Gemini requires uppercase type names in schemas, and does not accept additionalProperties
function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return schema;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties") {
      continue; // Gemini API does not support this field
    }
    if (k === "type" && typeof v === "string") {
      result[k] = v.toUpperCase();
    } else if ((k === "properties" || k === "items") && typeof v === "object" && v !== null) {
      if (k === "properties") {
        result[k] = Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [
            pk, toGeminiSchema(pv as Record<string, unknown>),
          ])
        );
      } else {
        result[k] = toGeminiSchema(v as Record<string, unknown>);
      }
    } else {
      result[k] = v;
    }
  }
  return result;
}

export function buildTool<Input>(def: ToolDef<Input>): Tool<Input> {
  const schema = zodToJsonSchema(def.inputSchema, { target: "openApi3" }) as Record<string, unknown>;
  return {
    ...def,
    toAnthropicTool(): AnthropicTool {
      return {
        name: def.name,
        description: def.description,
        input_schema: schema as AnthropicTool["input_schema"],
      };
    },
    toOpenAITool(): OpenAITool {
      return {
        type: "function",
        function: { name: def.name, description: def.description, parameters: schema },
      };
    },
    toGeminiTool(): GeminiFunctionDeclaration {
      return {
        name: def.name,
        description: def.description,
        parameters: toGeminiSchema(schema),
      };
    },
  };
}
