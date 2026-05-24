import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import * as path from "path";
import type { History } from "./types.js";

export type Session = {
  id: string;
  model: string;
  history: History;
  savedAt: string;
  preview: string;
};

const SESSION_DIR = path.join(homedir(), ".kodekode", "sessions");
const MAX_SESSIONS = 5;

function ensureDir() {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

export function saveSession(model: string, history: History) {
  ensureDir();
  const firstUser = history.messages.find((h) => h.role === "user");
  let preview = "セッション";
  if (firstUser) {
    if ("content" in firstUser && typeof firstUser.content === "string") {
      preview = firstUser.content.slice(0, 60);
    } else if ("parts" in firstUser) {
      const textPart = (firstUser as { parts: { text?: string }[] }).parts.find((p) => p.text);
      if (textPart?.text) preview = textPart.text.slice(0, 60);
    }
  }

  const id = Date.now().toString();
  const session: Session = { id, model, history, savedAt: new Date().toISOString(), preview };
  writeFileSync(path.join(SESSION_DIR, `${id}.json`), JSON.stringify(session), "utf8");

  const files = readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  for (const old of files.slice(MAX_SESSIONS)) {
    try { unlinkSync(path.join(SESSION_DIR, old)); } catch {}
  }
}

export function listSessions(): Session[] {
  ensureDir();
  return readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, MAX_SESSIONS)
    .map((f) => {
      try {
        return JSON.parse(readFileSync(path.join(SESSION_DIR, f), "utf8")) as Session;
      } catch {
        return null;
      }
    })
    .filter((s): s is Session => s !== null);
}
