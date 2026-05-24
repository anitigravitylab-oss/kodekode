import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionDecision } from "./types.js";

type Props = {
  toolName: string;
  preview: string;
  onDecide: (decision: PermissionDecision) => void;
};

const OPTIONS: { label: string; value: PermissionDecision }[] = [
  { label: "Allow once", value: "allow_once" },
  { label: "Always (session)", value: "always" },
  { label: "Deny", value: "deny" },
];

export default function PermissionPrompt({ toolName, preview, onDecide }: Props) {
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.leftArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.rightArrow) {
      setSelected((s) => Math.min(OPTIONS.length - 1, s + 1));
      return;
    }
    if (key.return) {
      const option = OPTIONS[selected];
      if (option) onDecide(option.value);
      return;
    }
    // Number shortcuts
    if (input === "1") { onDecide("allow_once"); return; }
    if (input === "2") { onDecide("always"); return; }
    if (input === "3") { onDecide("deny"); return; }
    if (input === "y" || input === "Y") { onDecide("allow_once"); return; }
    if (input === "n" || input === "N") { onDecide("deny"); return; }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">ツール実行の確認</Text>
      <Box marginTop={1}>
        <Text bold color="cyan">{toolName}</Text>
        <Text dimColor>: </Text>
        <Text>{preview.slice(0, 100)}{preview.length > 100 ? "…" : ""}</Text>
      </Box>
      <Box marginTop={1} gap={2}>
        {OPTIONS.map((opt, i) => (
          <Box key={opt.value}>
            {i === selected
              ? <Text bold color="green">[ {opt.label} ]</Text>
              : <Text dimColor>[ {opt.label} ]</Text>
            }
          </Box>
        ))}
      </Box>
      <Text dimColor>← → で選択  Enter で確定  (1=一度のみ 2=常に 3=拒否)</Text>
    </Box>
  );
}
