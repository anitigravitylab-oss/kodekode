import React, { useReducer, useRef, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { readdirSync } from "fs";
import { resolve } from "path";

type State = { value: string; cursor: number; historyIndex: number };
type Action =
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "delete_forward" }
  | { type: "move_left" }
  | { type: "move_right" }
  | { type: "move_home" }
  | { type: "move_end" }
  | { type: "set"; value: string }
  | { type: "clear" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "insert":
      return {
        ...state,
        value:
          state.value.slice(0, state.cursor) +
          action.text +
          state.value.slice(state.cursor),
        cursor: state.cursor + action.text.length,
      };
    case "backspace":
      if (state.cursor === 0) return state;
      return {
        ...state,
        value:
          state.value.slice(0, state.cursor - 1) +
          state.value.slice(state.cursor),
        cursor: state.cursor - 1,
      };
    case "delete_forward":
      if (state.cursor >= state.value.length) return state;
      return {
        ...state,
        value:
          state.value.slice(0, state.cursor) +
          state.value.slice(state.cursor + 1),
      };
    case "move_left":
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case "move_right":
      return { ...state, cursor: Math.min(state.value.length, state.cursor + 1) };
    case "move_home":
      return { ...state, cursor: 0 };
    case "move_end":
      return { ...state, cursor: state.value.length };
    case "set":
      return { value: action.value, cursor: action.value.length, historyIndex: state.historyIndex };
    case "clear":
      return { value: "", cursor: 0, historyIndex: -1 };
  }
}

/** Get the @word the cursor is currently in, or null */
function getAtWord(value: string, cursor: number): { word: string; start: number } | null {
  // Find the start of current word
  let start = cursor;
  while (start > 0 && value[start - 1] !== " " && value[start - 1] !== "\n") {
    start--;
  }
  const word = value.slice(start, cursor);
  if (!word.startsWith("@")) return null;
  return { word: word.slice(1), start };
}

/** List files matching a prefix in cwd */
function listFiles(prefix: string): string[] {
  try {
    const dir = process.cwd();
    const entries = readdirSync(resolve(dir));
    return entries.filter((e) => e.startsWith(prefix) && !e.startsWith(".")).slice(0, 8);
  } catch {
    return [];
  }
}

type Props = {
  onSubmit: (value: string) => void;
  placeholder?: string;
  isActive?: boolean;
  secret?: boolean;
  history?: string[];
};

export default function TextInput({
  onSubmit,
  placeholder,
  isActive = true,
  secret = false,
  history = [],
}: Props) {
  const [state, dispatch] = useReducer(reducer, { value: "", cursor: 0, historyIndex: -1 });
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");

  // File completions state
  const [completions, setCompletions] = useState<string[]>([]);
  const [completionIndex, setCompletionIndex] = useState(0);

  // Update completions when value changes
  useEffect(() => {
    const atWord = getAtWord(state.value, state.cursor);
    if (atWord) {
      const matches = listFiles(atWord.word);
      setCompletions(matches);
      setCompletionIndex(0);
    } else {
      setCompletions([]);
    }
  }, [state.value, state.cursor]);

  useInput(
    (input, key) => {
      // Shift+Enter or backslash at end of line = insert newline
      // Ink doesn't expose shift+enter reliably, but we can detect \ at end
      if (key.return) {
        // If value ends with \ (line continuation), replace \ with newline
        if (state.value.endsWith("\\")) {
          dispatch({ type: "backspace" });
          dispatch({ type: "insert", text: "\n" });
          return;
        }
        const val = state.value;
        dispatch({ type: "clear" });
        historyIndexRef.current = -1;
        draftRef.current = "";
        onSubmit(val);
        return;
      }

      // Tab: file completion
      if (key.tab) {
        if (completions.length > 0) {
          const atWord = getAtWord(state.value, state.cursor);
          if (atWord) {
            const chosen = completions[completionIndex] ?? completions[0];
            if (chosen) {
              // Replace @prefix with @chosen
              const before = state.value.slice(0, atWord.start);
              const after = state.value.slice(state.cursor);
              const newVal = `${before}@${chosen}${after}`;
              dispatch({ type: "set", value: newVal });
              // cycle through completions on repeated Tab
              setCompletionIndex((ci) => (ci + 1) % completions.length);
            }
          }
        }
        return;
      }

      if (key.upArrow && history.length > 0) {
        const next = Math.min(historyIndexRef.current + 1, history.length - 1);
        if (historyIndexRef.current === -1) draftRef.current = state.value;
        historyIndexRef.current = next;
        dispatch({ type: "set", value: history[next] ?? "" });
        return;
      }
      if (key.downArrow && history.length > 0) {
        const next = historyIndexRef.current - 1;
        historyIndexRef.current = next;
        if (next < 0) {
          dispatch({ type: "set", value: draftRef.current });
        } else {
          dispatch({ type: "set", value: history[next] ?? "" });
        }
        return;
      }
      if (key.leftArrow) { dispatch({ type: "move_left" }); return; }
      if (key.rightArrow) { dispatch({ type: "move_right" }); return; }
      if (key.ctrl && input === "a") { dispatch({ type: "move_home" }); return; }
      if (key.ctrl && input === "e") { dispatch({ type: "move_end" }); return; }
      if (key.ctrl && input === "k") { dispatch({ type: "set", value: state.value.slice(0, state.cursor) }); return; }
      if (key.backspace || key.delete) { dispatch({ type: "backspace" }); return; }
      if (key.escape || key.ctrl || key.meta) return;
      if (input) {
        dispatch({ type: "insert", text: input });
      }
    },
    { isActive },
  );

  // Render: handle multi-line values
  const lines = (secret ? "●".repeat(state.value.length) : state.value).split("\n");
  // Find which line and column the cursor is on
  let remaining = state.cursor;
  let cursorLine = 0;
  let cursorCol = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = (lines[i] ?? "").length;
    if (remaining <= lineLen) {
      cursorLine = i;
      cursorCol = remaining;
      break;
    }
    remaining -= lineLen + 1; // +1 for \n
    cursorLine = i + 1;
    cursorCol = 0;
  }

  const showPlaceholder = !state.value && placeholder;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {lines.map((line, li) => {
          if (li !== cursorLine) {
            return <Text key={li}>{line}</Text>;
          }
          const before = line.slice(0, cursorCol);
          const at = line[cursorCol] ?? " ";
          const after = line.slice(cursorCol + 1);
          return (
            <Box key={li}>
              <Text>{before}</Text>
              <Text inverse>{at}</Text>
              <Text>{after}</Text>
              {showPlaceholder && li === 0 && <Text dimColor>{placeholder}</Text>}
            </Box>
          );
        })}
      </Box>
      {/* File completion suggestions */}
      {completions.length > 0 && (
        <Box>
          {completions.map((c, i) => (
            <Text key={c} color={i === completionIndex ? "cyan" : undefined} dimColor={i !== completionIndex}>
              {" "}{c}
            </Text>
          ))}
          <Text dimColor>  Tab で補完</Text>
        </Box>
      )}
    </Box>
  );
}
