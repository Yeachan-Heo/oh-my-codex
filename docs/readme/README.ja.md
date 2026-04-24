# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>あなたのcodexは一人じゃない。</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[OpenClaw 統合ガイド](../openclaw-integration.ja.md)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

[OpenAI Codex CLI](https://github.com/openai/codex)のためのマルチエージェントオーケストレーションレイヤー。

## v0.9.0 の新機能 — Spark Initiative

Spark Initiative は、OMX のネイティブ探索・検査経路を強化するリリースです。

- **`omx explore` ネイティブハーネス** — 読み取り専用のリポジトリ探索を Rust ベースのハーネスで高速かつ厳格に実行します。
- **`omx sparkshell`** — 長い出力の要約と tmux pane キャプチャを行う、オペレーター向けのネイティブ検査サーフェスです。
- **クロスプラットフォームのネイティブリリース資産** — `omx-explore-harness`、`omx-sparkshell`、`native-release-manifest.json` を中心とした hydration 経路がリリースパイプラインに組み込まれました。
- **強化された CI/CD** — `build` ジョブでの明示的な Rust toolchain セットアップ、`cargo fmt --check`、`cargo clippy -- -D warnings` を追加しました。

詳細は [v0.9.0 リリースノート](../release-notes-0.9.0.md) と [リリース本文](../release-body-0.9.0.md) を参照してください。

## 最初のセッション

Codex内部で：

```text
$deep-interview "clarify the auth change"
$ralplan "approve the auth plan and review tradeoffs"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

ターミナルから：

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## 推奨ワークフロー

1. `$deep-interview` — スコープや境界がまだ曖昧なときに明確化するために使います。
2. `$ralplan` — 明確になった内容を、承認可能なアーキテクチャ/実装計画に落とし込みます。
3. `$team` または `$ralph` — 承認済みプランを並列で進めるなら `$team`、1 人の担当者が完了と検証まで粘り強く進めるなら `$ralph` を使います。

## コアモデル

OMXは以下のレイヤーをインストールして接続します：

```text
User
  -> Codex CLI
    -> AGENTS.md (オーケストレーションブレイン)
    -> ~/.codex/prompts/*.md (エージェントプロンプトカタログ)
    -> ~/.codex/skills/*/SKILL.md (スキルカタログ)
    -> ~/.codex/config.toml (機能、通知、MCP)
    -> .omx/ (ランタイム状態、メモリ、計画、ログ)
```

## 主要コマンド

```bash
omx                # Codexを起動（tmuxでHUD付き）
omx setup          # スコープ別にプロンプト/スキル/設定をインストール + プロジェクト .omx + スコープ別 AGENTS.md
omx doctor         # インストール/ランタイム診断
omx doctor --team  # Team/swarm診断
omx team ...       # tmuxチームワーカーの開始/ステータス/再開/シャットダウン
omx status         # アクティブなモードを表示
omx cancel         # アクティブな実行モードをキャンセル
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test（プラグイン拡張ワークフロー）
omx hud ...        # --watch|--json|--preset
omx help
```

## Hooks拡張（追加サーフェス）

OMXにはプラグインのスキャフォールディングとバリデーション用の`omx hooks`が含まれるようになりました。

- `omx tmux-hook`は引き続きサポートされ、変更されていません。
- `omx hooks`は追加的であり、tmux-hookワークフローを置き換えません。
- プラグインファイルは`.omx/hooks/*.mjs`に配置されます。
- プラグインはデフォルトで無効です；`OMX_HOOK_PLUGINS=1`で有効にします。

完全な拡張ワークフローとイベントモデルについては`docs/hooks-extension.md`を参照してください。

## 起動フラグ

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # setupのみ
```

`--madmax`はCodexの`--dangerously-bypass-approvals-and-sandbox`にマッピングされます。
信頼された/外部のサンドボックス環境でのみ使用してください。

### MCP workingDirectoryポリシー（オプションの強化）

デフォルトでは、MCP state/memory/traceツールは呼び出し元が提供する`workingDirectory`を受け入れます。
これを制限するには、許可されたルートのリストを設定します：

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

設定すると、これらのルート外の`workingDirectory`値は拒否されます。

## Codex-Firstプロンプト制御

デフォルトでは、OMXは以下を注入します：

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

これは`CODEX_HOME`の`AGENTS.md`とプロジェクトの`AGENTS.md`（存在する場合）を結合し、その上にランタイムオーバーレイを追加します。
Codexの動作を拡張しますが、Codexのコアシステムポリシーを置き換えたりバイパスしたりしません。

制御：

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # AGENTS.md注入を無効化
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## チームモード

並列ワーカーが有利な大規模作業にはチームモードを使用します。

ライフサイクル：

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

運用コマンド：

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

重要なルール：中断する場合を除き、タスクが`in_progress`状態の間はシャットダウンしないでください。

### Team shutdown policy

Use `omx team shutdown <team-name>` after the team reaches a terminal state.
Team cleanup now follows one standalone path; legacy linked-Ralph shutdown handling is no longer a separate public workflow.

チームワーカー用のWorker CLI選択：

```bash
OMX_TEAM_WORKER_CLI=auto    # デフォルト；worker --modelに"claude"が含まれる場合claudeを使用
OMX_TEAM_WORKER_CLI=codex   # Codex CLIワーカーを強制
OMX_TEAM_WORKER_CLI=claude  # Claude CLIワーカーを強制
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # ワーカーごとのCLIミックス（長さ=1またはワーカー数）
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # オプション：適応型queue->resendフォールバックを無効化
```

注意：
- ワーカー起動引数は引き続き`OMX_TEAM_WORKER_LAUNCH_ARGS`を通じて共有されます。
- `OMX_TEAM_WORKER_CLI_MAP`はワーカーごとの選択で`OMX_TEAM_WORKER_CLI`をオーバーライドします。
- トリガー送信はデフォルトで適応型リトライを使用します（queue/submit、必要に応じて安全なclear-line+resendフォールバック）。
- Claude workerモードでは、OMXはワーカーをプレーンな`claude`として起動し（追加の起動引数なし）、明示的な`--model` / `--config` / `--effort`オーバーライドを無視して、Claudeがデフォルトの`settings.json`を使用します。

## `omx setup`が書き込む内容

- `.omx/setup-scope.json`（永続化されたセットアップスコープ）
- スコープ依存のインストール：
  - `user`：`~/.codex/prompts/`、`~/.codex/skills/`、`~/.codex/config.toml`、`~/.omx/agents/`、`~/.codex/AGENTS.md`
  - `project`：`./.codex/prompts/`、`./.codex/skills/`、`./.codex/config.toml`、`./.omx/agents/`、`./AGENTS.md`
- 起動動作：永続化されたスコープが`project`の場合、`omx`起動時に自動的に`CODEX_HOME=./.codex`を使用（`CODEX_HOME`が既に設定されている場合を除く）。
- 起動命令は`~/.codex/AGENTS.md`（または上書きされた`CODEX_HOME/AGENTS.md`）とプロジェクトの`./AGENTS.md`を結合し、その後ランタイムオーバーレイを追加して使用します。
- 既存の`AGENTS.md`は黙って上書きされません。インタラクティブTTYでは置き換え前に確認し、非インタラクティブ実行では`--force`がない限り置き換えをスキップします（アクティブセッションの安全チェックは引き続き適用されます）。
- `config.toml`の更新（両スコープ共通）：
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "medium"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - MCPサーバーエントリ（`omx_state`、`omx_memory`、`omx_code_intel`、`omx_trace`）
  - `[tui] status_line`
- スコープ別`AGENTS.md`
- `.omx/`ランタイムディレクトリとHUD設定

## エージェントとスキル

- プロンプト：`prompts/*.md`（`user`は`~/.codex/prompts/`に、`project`は`./.codex/prompts/`にインストール）
- スキル：`skills/*/SKILL.md`（`user`は`~/.codex/skills/`に、`project`は`./.codex/skills/`にインストール）

例：
- エージェント：`architect`、`planner`、`executor`、`debugger`、`verifier`、`security-reviewer`
- スキル：`deep-interview`、`ralplan`、`team`、`ralph`、`plan`、`cancel`

## プロジェクト構成

```text
oh-my-codex/
  bin/omx.js
  src/
    cli/
    team/
    mcp/
    hooks/
    hud/
    config/
    modes/
    notifications/
    verification/
  prompts/
  skills/
  templates/
  scripts/
```

## 開発

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## ドキュメント

- **[完全なドキュメント](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — 完全ガイド
- **[CLIリファレンス](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — すべての`omx`コマンド、フラグ、ツール
- **[通知ガイド](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Discord、Telegram、Slack、webhookの設定
- **[推奨ワークフロー](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — 一般的なタスクのための実戦で検証されたスキルチェーン
- **[リリースノート](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — 各バージョンの新機能

## 備考

- 完全な変更ログ：`CHANGELOG.md`
- 移行ガイド（v0.4.4以降のmainline）：`docs/migration-mainline-post-v0.4.4.md`
- カバレッジとパリティノート：`COVERAGE.md`
- Hook拡張ワークフロー：`docs/hooks-extension.md`
- セットアップと貢献の詳細：`CONTRIBUTING.md`

## 謝辞

[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)にインスパイアされ、Codex CLI向けに適応されました。

## ライセンス

MIT
