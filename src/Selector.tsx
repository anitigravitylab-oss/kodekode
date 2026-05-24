import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

type Item<T> = { label: string; value: T; description?: string };

type Props<T> = {
  title: string;
  items: Item<T>[];
  onSelect: (value: T) => void;
  onCancel: () => void;
};

export default function Selector<T>({ title, items, onSelect, onCancel }: Props<T>) {
  const [cursor, setCursor] = useState(0);

  useInput((_, key) => {
    if (key.upArrow) {
      setCursor((c) => (c - 1 + items.length) % items.length);
    } else if (key.downArrow) {
      setCursor((c) => (c + 1) % items.length);
    } else if (key.return) {
      const item = items[cursor];
      if (item) onSelect(item.value);
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{title}</Text>
      <Text dimColor>↑↓ で移動  Enter で選択  Esc でキャンセル</Text>
      <Box flexDirection="column" marginTop={1}>
        {items.map((item, i) => (
          <Box key={String(i)}>
            <Text color={i === cursor ? "cyan" : undefined} bold={i === cursor}>
              {i === cursor ? "❯ " : "  "}
              {item.label}
            </Text>
            {item.description && (
              <Text dimColor>{"  "}{item.description}</Text>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
