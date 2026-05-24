# KodeKode

遊びで作った Claude Code クローンです。**全然だめ**ですが、自分用に動けばよしの精神で作っています。バグ多数・未完成・気まぐれに壊れます。実用は推奨しません。

TypeScript + React + [Ink](https://github.com/vadimdemedes/ink) + [Bun](https://bun.com) で動く TUI コーディングエージェント。複数の LLM プロバイダーを切り替えながら、ローカルマシン上でファイル編集・bash 実行・web 検索などをやらせて使います。

## 何ができる（やる）

- マルチプロバイダー対応: Claude（Anthropic）/ DeepSeek / OpenAI（API + OAuth 経由）/ Gemini
- ツール: `bash` / `read_file` / `write_file` / `edit_file` / `glob` / `grep` / `web_fetch` / `web_search` / `todo_write` / `task`（サブエージェント）/ バックグラウンドシェル
- ストリーミング応答、思考ブロック表示、Markdown レンダリング
- セッション保存・復元、`/compact` で会話圧縮
- ツール実行許可システム（`/yolo` で無効化）、Plan モード（`/plan`）
- カスタムスラッシュコマンド（`~/.kodekode/commands/*.md`）
- CLAUDE.md 自動ロード
- プロンプトキャッシング（Anthropic のみ）
- 各 API のタイムアウト・自動リトライ・連続失敗時のヒント挿入

## 動作確認モデル

- `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`
- `deepseek-v4-pro`, `deepseek-v4-flash`
- `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`（OAuth 経由は `npx openai-oauth` プロキシ必要）
- `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`

## インストール

```bash
git clone https://github.com/anitigravitylab-oss/kodekode.git
cd kodekode
bun install
chmod +x index.tsx
# 必要なら PATH に通す:
sudo ln -s "$(pwd)/index.tsx" /usr/local/bin/kodekode
```

## 起動

```bash
kodekode      # シンボリックリンクした場合
# もしくは
bun run index.tsx
```

初回起動時にプロバイダーと API キーを聞かれます。設定は `~/.kodekode/config.json` に保存されます。

## スラッシュコマンド

```
/help            コマンド一覧
/model           モデルを切り替え
/clear           会話履歴をリセット
/compact         会話を要約して圧縮
/resume          過去のセッションを復元
/plan            プランモードをトグル
/yolo            ツール許可確認をスキップ
/cost            累計トークン使用量とコスト推定
/diff            このセッションで変更されたファイルの diff
/init            CLAUDE.md を生成
/exit            終了
```

入力欄の特殊機能:
- `\` 行末で改行（複数行入力）
- `@filename` で Tab 補完
- 行頭 `!` でシェル直接実行
- 行頭 `#` でメモ（`~/.kodekode/notes.md` に追記）

## 既知のだめなところ

- OpenAI OAuth (`npx openai-oauth`) が時々ハング（プロキシの問題）
- Gemini で複数 functionCall を返したとき不安定な時がある
- Plan モードの UI が雑
- Markdown レンダリングが Ink のレイアウトと喧嘩することがある
- 全般的に大きな入力やエッジケースで落ちる
- テストない
- ドキュメントない
- だめ

## なぜ作ったか

Claude Code（[claude.com/claude-code](https://claude.com/claude-code)）を実際に使っていて、自分でも同じようなのを書いてみたくなって遊びで作りました。Claude Code の方がはるかに完成度が高いので、本気で使うならそっちです。これは勉強と趣味のためのおもちゃ。

## ライセンス

MIT
