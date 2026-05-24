import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

export type Config = {
  deepseekApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  openaiOAuth?: boolean; // ~/.codex/auth.json が存在することで有効
  defaultProvider?: "deepseek" | "anthropic" | "openai-oauth" | "openai-api" | "gemini";
  /** サブエージェントで使うモデル（未設定時はメインモデルと同じ） */
  subagentModel?: string;
};

const CONFIG_PATH = join(homedir(), ".kodekode", "config.json");
export const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");

export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch {
    return null;
  }
}

export function saveConfig(config: Config): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  try { chmodSync(CONFIG_PATH, 0o600); } catch {}
}

export function applyConfig(config: Config): void {
  if (config.deepseekApiKey)  process.env.DEEPSEEK_API_KEY  = config.deepseekApiKey;
  if (config.anthropicApiKey) process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  if (config.openaiApiKey)    process.env.OPENAI_API_KEY    = config.openaiApiKey;
  if (config.geminiApiKey)    process.env.GEMINI_API_KEY    = config.geminiApiKey;
}

// オンボード済みかどうか：config.json か codex auth どちらかあればOK
export function isConfigured(): boolean {
  return existsSync(CONFIG_PATH) || existsSync(CODEX_AUTH_PATH);
}
