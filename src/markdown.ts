// Simple markdown renderer for terminal output using marked + marked-terminal
// Falls back to plain text if packages are unavailable

let renderer: ((text: string) => string) | null = null;
let rendererTried = false;

function getRenderer(): (text: string) => string {
  if (rendererTried) return renderer ?? ((s) => s);
  rendererTried = true;
  try {
    // Dynamic import to avoid startup crash if package missing
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { marked } = require("marked") as { marked: { parse: (s: string, opts?: unknown) => string; setOptions: (opts: unknown) => void } };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TerminalRenderer = require("marked-terminal") as { default: unknown } | unknown;
    const TR = (TerminalRenderer as { default: unknown }).default ?? TerminalRenderer;
    marked.setOptions({ renderer: new (TR as new () => unknown)() as never });
    renderer = (text: string) => {
      try {
        const result = marked.parse(text, { async: false } as never);
        // marked may return a string or Promise; handle both
        if (typeof result === "string") return result.trimEnd();
        return text;
      } catch {
        return text;
      }
    };
  } catch {
    renderer = null;
  }
  return renderer ?? ((s) => s);
}

export function renderMarkdown(text: string): string {
  return getRenderer()(text);
}
