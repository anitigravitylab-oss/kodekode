#!/usr/bin/env bun
import { readSync, existsSync } from "fs";
import { spawnSync, execSync } from "child_process";
import React from "react";
import { render } from "ink";
import { loadConfig, saveConfig, applyConfig, isConfigured, CODEX_AUTH_PATH } from "./src/config.js";
import App from "./src/App.js";

// config.json から API キーを読み込んで process.env に適用
const config = loadConfig();
if (config) applyConfig(config);

// API キーの隠し入力（echo なし）
function readSecret(promptText: string): string {
  process.stdout.write(promptText);
  try { execSync("stty -echo", { stdio: "inherit" }); } catch {}
  let result = "";
  const buf = Buffer.alloc(1);
  while (true) {
    const n = readSync(0, buf, 0, 1, null);
    if (n === 0 || buf[0] === 10 || buf[0] === 13) break;
    if (buf[0] === 127 || buf[0] === 8) { result = result.slice(0, -1); }
    else { result += String.fromCharCode(buf[0]!); }
  }
  try { execSync("stty echo", { stdio: "inherit" }); } catch {}
  process.stdout.write("\n");
  return result.trim();
}

// オンボーディング（~/.kodekode/config.json も ~/.codex/auth.json もない場合のみ）
if (!isConfigured()) {
  console.log("");
  console.log("  KodeKode — 初回セットアップ");
  console.log("  ─────────────────────────────────────────────");
  console.log("  使用するプロバイダーを選択してください:");
  console.log("");
  console.log("  1. DeepSeek       — API キー");
  console.log("  2. Claude         — Anthropic API キー");
  console.log("  3. OpenAI OAuth   — ChatGPT サブスク（デバイスコード認証）");
  console.log("  4. OpenAI API     — OpenAI API キー");
  console.log("  5. Gemini         — Google API キー");
  console.log("  0. スキップ");
  console.log("");

  const choice = prompt("  番号を入力 [0-5]: ")?.trim() ?? "0";
  console.log("");
  const newConfig: ReturnType<typeof loadConfig> = config ?? {};

  switch (choice) {
    case "1": {
      const key = readSecret("  DeepSeek API キー: ");
      if (key) {
        newConfig!.deepseekApiKey = key;
        newConfig!.defaultProvider = "deepseek";
        process.env.DEEPSEEK_API_KEY = key;
        saveConfig(newConfig!);
        console.log("  ✓ DeepSeek を設定しました。");
      }
      break;
    }
    case "2": {
      const key = readSecret("  Anthropic API キー (sk-ant-...): ");
      if (key) {
        newConfig!.anthropicApiKey = key;
        newConfig!.defaultProvider = "anthropic";
        process.env.ANTHROPIC_API_KEY = key;
        saveConfig(newConfig!);
        console.log("  ✓ Claude を設定しました。");
      }
      break;
    }
    case "3": {
      console.log("  URL とコードが表示されます。任意のデバイスで URL を開いてコードを入力してください。");
      console.log("");
      const result = spawnSync("npx", ["@openai/codex", "login", "--device-auth"], { stdio: "inherit" });
      console.log("");
      if (result.status === 0 && existsSync(CODEX_AUTH_PATH)) {
        newConfig!.defaultProvider = "openai-oauth";
        saveConfig(newConfig!);
        console.log("  ✓ OpenAI OAuth 認証が完了しました。");
      } else {
        saveConfig(newConfig ?? {});
        console.log("  ⚠ 認証に失敗しました。後から agent を再起動して再試行できます。");
      }
      break;
    }
    case "4": {
      const key = readSecret("  OpenAI API キー (sk-...): ");
      if (key) {
        newConfig!.openaiApiKey = key;
        newConfig!.defaultProvider = "openai-api";
        process.env.OPENAI_API_KEY = key;
        saveConfig(newConfig!);
        console.log("  ✓ OpenAI API を設定しました。");
      }
      break;
    }
    case "5": {
      const key = readSecret("  Google (Gemini) API キー: ");
      if (key) {
        newConfig!.geminiApiKey = key;
        newConfig!.defaultProvider = "gemini";
        process.env.GEMINI_API_KEY = key;
        saveConfig(newConfig!);
        console.log("  ✓ Gemini を設定しました。");
      }
      break;
    }
    default:
      saveConfig(newConfig ?? {});
      console.log("  → スキップしました。/model から使用するモデルを選択できます。");
  }
  console.log("");
}

render(<App />);
