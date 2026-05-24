#!/usr/bin/env bun
import { readFileSync } from "fs";

try {
  const env = readFileSync(import.meta.dir + "/.env", "utf8");
  for (const line of env.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#")) {
      process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
} catch {}

import { runAgent } from "./src/agent.js";

const prompt = process.argv[2] ?? "カレントディレクトリのファイル一覧を教えて";

console.log(`> ${prompt}\n`);

for await (const event of runAgent([{ role: "user", content: prompt }])) {
  if (event.type === "text") process.stdout.write(event.text);
  else if (event.type === "tool_use") console.log(`\n[tool] ${event.name}: ${JSON.stringify(event.input)}`);
  else if (event.type === "tool_result") console.log(`[result] ${event.result.slice(0, 200)}`);
  else if (event.type === "done") console.log("\n[done]");
}
