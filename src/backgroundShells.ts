import { spawn, type ChildProcess } from "child_process";
import { appendFileSync } from "fs";

function dbg(msg: string) {
  const t = new Date().toISOString().slice(11, 23);
  appendFileSync("/tmp/kodekode.log", `[${t}] [bg] ${msg}\n`);
}

export type ShellState = {
  id: string;
  description: string;
  process: ChildProcess;
  lines: string[];          // ring buffer
  running: boolean;
  exitCode: number | null;
};

const MAX_LINES = 2000;
let shellCounter = 0;
const shells = new Map<string, ShellState>();

/** Spawn a background shell. Returns the shell_id. */
export function spawnBackgroundShell(command: string, cwd: string, description: string): string {
  shellCounter++;
  const id = `bash_${String(shellCounter).padStart(3, "0")}`;

  const child = spawn("/bin/bash", ["-c", command], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const state: ShellState = {
    id,
    description,
    process: child,
    lines: [],
    running: true,
    exitCode: null,
  };
  shells.set(id, state);

  function appendLine(line: string) {
    state.lines.push(line);
    if (state.lines.length > MAX_LINES) state.lines.shift();
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    chunk.toString().split("\n").forEach((l) => appendLine(l));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    chunk.toString().split("\n").forEach((l) => appendLine(`[stderr] ${l}`));
  });
  child.on("exit", (code) => {
    state.running = false;
    state.exitCode = code;
    appendLine(`[exit: ${code}]`);
    dbg(`shell ${id} exited with code ${code}`);
  });

  dbg(`spawned shell ${id}: ${command.slice(0, 80)}`);
  return id;
}

/** Get lines since a given index. Returns { lines, running, exitCode, totalLines }. */
export function getShellOutput(id: string, sinceLine = 0): {
  lines: string[];
  running: boolean;
  exitCode: number | null;
  totalLines: number;
} | null {
  const state = shells.get(id);
  if (!state) return null;
  return {
    lines: state.lines.slice(sinceLine),
    running: state.running,
    exitCode: state.exitCode,
    totalLines: state.lines.length,
  };
}

/** Kill a background shell. Returns true if found. */
export function killShell(id: string): boolean {
  const state = shells.get(id);
  if (!state) return false;
  if (state.running) {
    state.process.kill("SIGTERM");
    dbg(`killed shell ${id}`);
  }
  return true;
}

/** List all shell IDs and their status */
export function listShells(): Array<{ id: string; description: string; running: boolean; exitCode: number | null }> {
  return [...shells.values()].map((s) => ({
    id: s.id,
    description: s.description,
    running: s.running,
    exitCode: s.exitCode,
  }));
}
