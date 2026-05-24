# KodeKode

A toy Claude Code clone I built for fun. **It's not good.** Built with the "works on my machine, ship it" mentality. Lots of bugs, unfinished features, breaks randomly. Not recommended for actual use.

A TUI coding agent in TypeScript + React + [Ink](https://github.com/vadimdemedes/ink) + [Bun](https://bun.com). Switch between multiple LLM providers and let them edit files, run bash, search the web, etc. on your local machine.

## What it can (try to) do

- **Multi-provider**: Claude (Anthropic) / DeepSeek / OpenAI (API + OAuth proxy) / Gemini
- **Tools**: `bash` / `read_file` / `write_file` / `edit_file` / `glob` / `grep` / `web_fetch` / `web_search` / `todo_write` / `task` (sub-agent) / background shells
- Streaming responses, thinking-block display, Markdown rendering
- Session save/restore, `/compact` for conversation summarization
- Tool permission system (`/yolo` to disable), Plan mode (`/plan`)
- Custom slash commands (`~/.kodekode/commands/*.md`)
- Auto-load `CLAUDE.md` from project tree
- Prompt caching (Anthropic only)
- Per-API timeout, auto-retry, recovery hints on consecutive failures

## Supported models

- `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`
- `deepseek-v4-pro`, `deepseek-v4-flash`
- `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` (OAuth route needs `npx openai-oauth` proxy)
- `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`

## Install

```bash
git clone https://github.com/anitigravitylab-oss/kodekode.git
cd kodekode
bun install
chmod +x index.tsx
# Optional: put it on your PATH
sudo ln -s "$(pwd)/index.tsx" /usr/local/bin/kodekode
```

## Run

```bash
kodekode      # if you symlinked
# or
bun run index.tsx
```

On first launch you'll be asked for a provider and API key. Settings are saved to `~/.kodekode/config.json`.

## Slash commands

```
/help            list commands
/model           switch model
/clear           reset conversation
/compact         summarize & shrink the conversation
/resume          restore a past session
/plan            toggle plan mode
/yolo            skip tool permission prompts
/cost            cumulative token usage + cost estimate
/diff            diff of files changed this session
/init            generate a CLAUDE.md for the current dir
/exit            quit
```

Input box specials:

- Trailing `\` for newline (multi-line input)
- `@filename` with Tab completion
- Lines starting with `!` run as a shell command directly
- Lines starting with `#` append a note to `~/.kodekode/notes.md`

## Known badness

- OpenAI OAuth (`npx openai-oauth`) sometimes hangs (proxy quirks)
- Gemini gets flaky when returning multiple functionCalls in one turn
- Plan mode UI is rough
- Markdown rendering occasionally fights with Ink's layout
- Crashes on large inputs and edge cases in general
- No tests
- No docs
- Not good

## Why I built this

I use [Claude Code](https://claude.com/claude-code) daily and wanted to try writing something similar myself. Claude Code is vastly more polished — if you actually want to use a tool like this, use Claude Code. This is a toy for learning and tinkering.

## License

MIT
