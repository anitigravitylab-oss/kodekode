import { z } from "zod";
import { buildTool } from "./Tool.js";
import TurndownService from "turndown";

const inputSchema = z.object({
  url: z.string().describe("取得する URL"),
  prompt: z.string().optional().describe("取得内容に対する質問や指示（省略可）"),
});

export const WebFetchTool = buildTool({
  name: "web_fetch",
  description: "URL からページを取得してテキスト/Markdown に変換して返す。Web ページの内容を読むときに使う。",
  inputSchema,
  isReadOnly: true,
  async call({ url, prompt }, _context) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    let html: string;
    let finalUrl = url;
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "KodeKode/0.1" },
      });
      clearTimeout(timer);
      finalUrl = res.url;
      if (!res.ok) {
        return { type: "error", text: `HTTP ${res.status} ${res.statusText} from ${url}` };
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("html") && !contentType.includes("text")) {
        // Try reading as text anyway
        html = await res.text();
      } else {
        html = await res.text();
      }
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return { type: "error", text: `fetch エラー: ${msg}` };
    }

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1]!.trim() : "";

    // Remove script/style/nav/header/footer before converting
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "");

    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    let contentMarkdown = td.turndown(cleaned);

    // Trim to 8000 chars
    if (contentMarkdown.length > 8000) {
      contentMarkdown = contentMarkdown.slice(0, 8000) + "\n…(省略)";
    }

    const result: Record<string, string> = { url: finalUrl, title, contentMarkdown };
    if (prompt) {
      result["prompt"] = prompt;
    }

    return { type: "text", text: JSON.stringify(result, null, 2) };
  },
});
