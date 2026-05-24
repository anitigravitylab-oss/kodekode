#!/usr/bin/env bun
// IME診断: 受信バイト列をそのまま表示する

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("日本語を入力して確定してください。Ctrl+Cで終了。\r\n\r\n");

process.stdin.on("data", (buf: Buffer) => {
  const hex = buf.toString("hex").match(/.{2}/g)?.join(" ") ?? "";
  const text = [...buf].map(b =>
    b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b < 0x20 ? `^${String.fromCharCode(b + 64)}` : `\\x${b.toString(16).padStart(2, "0")}`
  ).join("");

  process.stdout.write(`hex: ${hex}\r\n`);
  process.stdout.write(`chr: ${text}\r\n`);
  process.stdout.write(`raw: ${JSON.stringify(buf.toString("utf8"))}\r\n`);
  process.stdout.write("---\r\n");

  if (buf[0] === 3) { // Ctrl+C
    process.stdin.setRawMode(false);
    process.exit(0);
  }
});
