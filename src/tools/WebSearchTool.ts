import { z } from "zod";
import { buildTool } from "./Tool.js";
import { parse } from "node-html-parser";

const inputSchema = z.object({
  query: z.string().describe("検索クエリ"),
  max_results: z.number().optional().describe("最大件数（デフォルト 5）"),
});

export const WebSearchTool = buildTool({
  name: "web_search",
  description: "DuckDuckGo でウェブ検索してタイトル・URL・スニペットのリストを返す。",
  inputSchema,
  isReadOnly: true,
  async call({ query, max_results = 5 }, _context) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    let html: string;
    try {
      const res = await fetch(searchUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "KodeKode/0.1",
          "Accept": "text/html",
        },
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { type: "error", text: `DuckDuckGo HTTP ${res.status}` };
      }
      html = await res.text();
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return { type: "error", text: `web_search エラー: ${msg}` };
    }

    const root = parse(html);
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    // DuckDuckGo HTML result links have class "result__a"
    const links = root.querySelectorAll("a.result__a");
    for (const link of links) {
      if (results.length >= max_results) break;
      const title = link.textContent.trim();
      let href = link.getAttribute("href") ?? "";
      // DDG wraps URLs: /l/?uddg=<encoded_url>&...
      if (href.startsWith("/l/")) {
        const m = href.match(/[?&]uddg=([^&]+)/);
        if (m) href = decodeURIComponent(m[1]!);
      } else if (href.startsWith("//")) {
        href = "https:" + href;
      }
      if (!href) continue;

      // Find sibling snippet
      const parent = link.parentNode?.parentNode; // .result__body -> .result
      let snippet = "";
      if (parent) {
        const snipEl = parent.querySelector(".result__snippet");
        if (snipEl) snippet = snipEl.textContent.trim();
      }

      results.push({ title, url: href, snippet });
    }

    if (results.length === 0) {
      return { type: "text", text: JSON.stringify({ query, results: [], note: "結果が見つかりませんでした。" }) };
    }

    return { type: "text", text: JSON.stringify({ query, results }, null, 2) };
  },
});
