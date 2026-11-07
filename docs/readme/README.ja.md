# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Codexをより強力に使い始め、作業が大きくなったらOMXがプロンプト、ワークフロー、ランタイムを支援します。</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Web:** https://yeachan-heo.github.io/oh-my-codex-website/  
**ドキュメント:** [はじめに](../../docs/getting-started.html) · [エージェント](../../docs/agents.html) · [スキル](../../docs/skills.html) · [統合](../../docs/integrations.html) · [デモ](../../DEMO.md) · [OpenClaw ガイド](../openclaw-integration.md)  
**コミュニティ:** [Discord](https://discord.gg/wSyUQYfhAw) — oh-my-codex、[gajae-code](https://github.com/Yeachan-Heo/gajae-code) などの共通 Gajae コミュニティ。

## 公式プロジェクトとパッケージ

公式 OMX プロジェクトはこのリポジトリ [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)、公式 npm パッケージは [oh-my-codex](https://www.npmjs.com/package/oh-my-codex) です。`npm install -g oh-my-codex` でインストールしてください。「OMX v2」などの名称を使う第三者プロジェクトやフォークは、README またはドキュメントで明記されない限り、公式の後継・置き換え・リリース系列ではありません。不明な場合は、このリポジトリと npm パッケージを公式の入手先として扱ってください。

OMX は [OpenAI Codex CLI](https://github.com/openai/codex) のワークフローレイヤーです。Codex を実行エンジンとして維持しながら、強力な標準セッション、明確な作業フロー、`$plan`、`$ultragoal`、`$team`、`$code-review`、`$ultraqa` など個別に呼び出せるワークフロー、プロジェクトガイダンス、`.omx/` の永続状態を提供します。

> ⚠️ **推奨される標準環境は macOS または Linux + Codex CLI です。** OMX は主にこの経路向けに設計・調整されています。ネイティブ Windows と Codex App は標準体験ではなく、動作が不安定な場合があり、サポートも限定的です。

## コアメンテナー

| 役割 | 名前 | GitHub |
| --- | --- | --- |
| 制作者・リード | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| メンテナー | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| メンテナー | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## アンバサダーと主なコントリビューター

- アンバサダー: Sigrid Jin ([ @sigridjineth ](https://github.com/sigridjineth))
- 主なコントリビューター: Doyun Ha、Junho Yeo、JiHongKim98、Lor、HyunjunJeon。[GitHub の一覧](https://github.com/Yeachan-Heo/oh-my-codex/graphs/contributors)も参照してください。

## 推奨される標準フロー

Codex CLI がすでにインストール済みの場合:

```bash
codex --version
npm install -g oh-my-codex
# Codex に編集させたい Git プロジェクト内で、タスク固有の名前を選んで実行
omx --worktree=feat/task --madmax --xhigh
```

Codex CLI がまだなく、npm で管理する場合:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

既存の Homebrew 管理 `codex` バイナリ（例: `/opt/homebrew/bin/codex`）に npm から Codex を重ねてインストールしないでください。`EEXIST` が発生することがあります。OMX に必要なのは PATH 上で利用できる認証済みの `codex` コマンドであり、npm 版 Codex ではありません。OMX のバージョンを更新した後、setup は自動起動しないため、`omx setup --scope project --merge-agents` または `omx update` を実行してください。起動時の npm 更新確認は頻度制限付きで、通常は確認を求めます。`OMX_AUTO_UPDATE=0` で無効化、`OMX_AUTO_UPDATE=defer` で確認せずセッション終了後に予約できます。

setup の範囲は意図的に選んでください。対象 Git プロジェクトに永続 `AGENTS.md` ガイダンスを置く場合は `omx setup --scope project --merge-agents`、ユーザー共通設定には `omx setup --scope user` を使います。ホームディレクトリから project setup を実行するのは、その場所が本当に対象プロジェクトの場合だけにしてください。merge の選択はルートごとのポリシーで、force やデフォルトではありません。生成セクションは `<!-- OMX:AGENTS:START -->` と `<!-- OMX:AGENTS:END -->` の間に管理されます。

Codex プラグイン用の公式レイアウトも `plugins/oh-my-codex` に含まれます。プラグインモードでも実行時にはインストール済み OMX CLI を使い、永続ガイダンス用の `AGENTS.md` が必要です。`omx setup --disable-hooks` は OMX 管理フックを無効にし、通常のアセットや設定より先に終了します。

インストール後に次を確認してください:

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` は OMX ファイル、フック、ランタイム要件を確認します。実際の実行スモークテストでは、現在のシェルの認証、プロファイル、エンドポイントを含め Codex が実リクエストを行えることを確認できます。

## 最初のセッションと安全な起動

macOS/Linux で tmux が使える場合、OMX は通常リーダーを OMX 管理の detached tmux で起動し、HUD やランタイム pane を復元できるようにします。`--worktree` は別の Git checkout で実行し、特に `--madmax` と併用する場合の推奨方法です。繰り返し使う worktree には名前を付けてください。

`--madmax` は Codex の `--dangerously-bypass-approvals-and-sandbox` の省略形です。通常の承認と sandbox 保護を取り除くため、信頼できるリポジトリと環境でのみ使います。`--high` と `--xhigh` は reasoning effort の省略形です。並行実行には `--worktree=feature/auth` のような名前付き worktree を使います。名前なし `--worktree` は一時的な detached worktree です。作成後に元 checkout の HEAD が進むと `worktree_target_mismatch` で失敗することがあります。対象 worktree が dirty の場合、OMX は警告してそのまま起動するため、隔離が必要なら先に clean/commit/stash してください。Team の worker は標準で専用 worktree を使います。

通常の起動は選択した `OMX_ROOT` 内の書き込み可能なセッションポインターを1つ所有します。同じ checkout から2つ目の通常起動をすると、共有や root の暗黙変更を避けるため失敗します。別の会話には固有 root を指定します:

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
OMX_ROOT="$HOME/.omx/instances/third-conversation" omx
```

PowerShell: `$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"`  
Command Prompt: `set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"`

同じ明示的 `OMX_ROOT` を複数回使うと所有権競合になります。別 checkout は別の標準 root を持ちます。repo-aware ツールにはリポジトリ/worktree ルート、Git common dir、CodeGraph モードの `OMX_*` コンテキストが渡されます。auto モードは worktree ローカル DB、リーダー/リポジトリ DB の順に使い、なければ off になります。OMX は CodeGraph をインストール、索引化、コピー、symlink しません。共有 index は基準ナビゲーションには便利ですが、worktree 固有の変更は反映されません。

tmux/HUD 管理のない一度限りの起動には `omx --direct --yolo`、プロファイルの既定値には `OMX_LAUNCH_POLICY=direct omx --yolo` を使います。`direct|tmux|detached-tmux|auto` を選べ、CLI フラグが環境変数より優先されます。既存 tmux pane 内で `--direct` を実行しても新しい HUD split は作られませんが、プロセスはその pane 内で動きます。

## OMX が提供するもの

OMX は Codex を置き換えません。実際の作業は Codex が行い、OMX の role keyword は役割を再利用可能にし、skill は共通ワークフローを再利用可能にし、`.omx/` は計画、ログ、メモリ、ランタイム状態を保存します。OMX は手動操作のための単なるコマンド群ではなく、タスクルーティング、ワークフロー、ランタイムを改善するレイヤーです。Codex だけで十分なら OMX は不要かもしれません。

## 初めて使う場合

1. `codex --version` で Codex CLI を確認し、`npm install -g oh-my-codex` で OMX をインストール/更新します。npm 管理の Codex が必要なら `@openai/codex` を別途インストールします。
2. OMX の実バージョン更新後、対象プロジェクトで `omx setup --scope project --merge-agents`、ユーザー設定には `omx setup --scope user` を実行します。npm 更新も必要なら `omx update` を使います。
3. `omx doctor` を実行します。
4. `codex login status` と `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"` で実行を確認します。
5. Git project では名前付き worktree から起動します。同時 `--madmax` セッションはそれぞれ別 worktree にします。
6. 要求や境界が曖昧なら `$deep-interview`。
7. 計画と trade-off の確認には `$ralplan`。
8. 永続目的を明示するには `/goal`、永続的な複数目標実行には `$ultragoal`、調整された並列実行には `$team`。

## 推奨ワークフロー

`$autopilot` は `$deep-interview -> $ralplan -> $ultragoal` を段階的に実行する標準オーケストレーターです。前提となる成果物がすでにある場合は各段階を個別に呼び出せます。

1. `$deep-interview`: 質問を重ねて曖昧さを解消し、実行可能な要件を作成。
2. `$ralplan`: 要件をもとにアーキテクチャ、実現可能性、合意を検討。
3. `$ultragoal`: `.omx/ultragoal` のチェックポイントを使って複数目標を永続的に実行。
4. `$team`: 複数 lane の調整が有益な作業で使う。

`$deep-interview` は独立した要件整理段階であり、`$plan --interview` の別名ではなく、実装もしません。Planning skill は計画成果物までで、コード変更には明示的な実行 lane が必要です。Ultragoal のストーリー内でも、並列調整が有益なときだけ Team を使います。

### セッションでよく使う機能

| 機能 | 用途 |
| --- | --- |
| `$plan "..."` | 任意の計画と要件の明確化 |
| `$ultragoal "..."` | 承認済み計画の永続的な実行 |
| `$team "..."` | 十分に大きい作業の並列実行 |
| `/skills` | インストール済み skills と補助機能の確認 |
| `/goal ...` | ターンをまたいで進捗を照合する永続目標/チェックポイント |
| `omx mission <file>` | prompt/checklist の順次 batch 実行 |

## 高度な/運用者向け機能

### Mission キュー

`omx mission plan ./mission.md` または `omx mission ./mission.md --dry-run` で入力を検査し、`omx mission run ./mission.md -- --model gpt-5` で実行します。中断した run は `status`、`resume`、`mark --status blocked`、`rerun --task` で確認/再開/修復できます。summary と ledger は `.omx/missions/<slug>/` に保存されます。[Mission ドキュメント](../../docs/mission.md)。

### 過去の会話をエクスポート

`omx session search "覚えている語句"` で session ID を見つけ、`omx session export <session-id> --output conversation.md` で保存します。完全 ID または一意な prefix を受け付け、同じ Codex home の active/archive transcript を対象にします。`--format json`、`--include-tools`、`--codex-home <path>` を指定できます。`--output` を省略すると stdout に出力し、既存ファイルは上書きしません。既定では user/assistant のみを含み system/developer 指示と reasoning を除外しますが、本文は redaction されません。[session export](../../docs/session-export.md)。

### トークン使用量と実行タイムライン

`omx session usage --since 7d --sort tokens` でローカルの active/archive session の累積使用量を確認します。`--project current`、`--session`、`--json`、`--codex-home`、`--limit` を指定できます。期間は最後に記録された活動で session を選ぶので、期間内の請求/消費量ではありません。mirror は一度だけ数え、測定値がなければ unknown です。[session usage](../../docs/session-usage.md)。

`omx session timeline <session-id>` は会話本文をエクスポートせず、tool call、turn、compaction、エラー、所要時間を調べます。`--kind tools --sort duration --limit 10`、`--status failed`、`--tool <name>`、`--json --output timeline.json` を使えます。filter/pagination は event list のみを変え、summary は全 session を対象にします。不明な時間は unknown とし、明示的な error がないことは成功の証明ではありません。[session timeline](../../docs/session-timeline.md)。

### Team ランタイム

Team は永続 tmux/worktree 調整が必要な場合に使うもので、OMX の標準的な入り口ではありません。Codex App や tmux 外のセッションでは `omx team` はアプリ内ワークフローでなく shell runtime として扱い、必要なら先に shell から OMX CLI を起動します。Ultragoal に結び付く Team では目標状態はリーダーが所有し、worker は証拠をリーダーに報告します。開始時に再開用 preflight context が保存されます。ごく小さな作業では worker 数が1に制限され、過剰な調整の警告が出ることがあります。

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

`omx team status` と `omx tmux-hook status` は参照のみで、claim 回収、mailbox 配信、commit 統合、状態変更はしません。hook 設定がなければ報告するだけです。初期化には `omx tmux-hook init` を使います。

### Setup、doctor、HUD

Codex plugin marketplace は plugin bundle を `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/` にキャッシュすることがあります。bundle には Codex lifecycle hooks、任意の MCP compatibility server、app metadata が含まれますが、MCP/app は既定で無効で、実行には installed `omx` CLI が必要です。scope に応じて setup は prompt、skill、AGENTS scaffolding、config、旧 Codex 向け native hook を管理します。ユーザー作成 hook を保ち、OMX wrapper のみを更新します。uninstall はユーザー hook が残る場合ファイルを保持します。

`omx update` は npm を確認して global OMX を更新し、同じ setup refresh を再実行します。新規 setup の標準 model は `gpt-6-astra` で、既存 user 設定と明示的 override は維持されます。.omx-config の model/env 設定は[参照資料](../../docs/reference/omx-config-schema-routing.md)を確認し、利用中の版がサポートする key のみ編集してください。`omx doctor` はインストール形状を検査しますが認証済み model call の成功は証明しません。HUD は監視用です。

HUD には現在の Team 名/worker 数、agent の状態・task・role・pane・更新時刻が表示されます。不明な status は unknown と表示され、`working` はプロセス生存を意味しません。team data は変更せず読み取ります。GitGuardex の完了段階表示はプロジェクト `.omx/hud-config.json` に `"guardex": { "enabled": true }` を設定した場合のみ有効です。画面に収まらない worker は `+N workers` とまとめられます。

Team 以外の session では native Codex hook が標準です: plugin は `plugins/oh-my-codex/hooks/hooks.json`、legacy/旧 Codex は `.codex/hooks.json`、OMX plugin hook は `.omx/hooks/*.mjs`、tmux/通知/watcher は fallback 経路です。[Codex native hook mapping](../../docs/codex-native-hooks.md)。

### 準備完了なのに実行できない場合

`omx doctor` が green でも実行できない場合、OMX を起動する同じ shell/profile で `codex login status` と実リクエストを確認します。custom HOME、profile、container、service shell の `CODEX_HOME` が期待する認証/設定を指すことを確認してください。ローカル OpenAI 互換 proxy では active `config.toml` の `openai_base_url` を確認します。team resume が死んだ tmux session を報告する場合、停止済み/放棄済みと確認した team にのみ force shutdown を実行し、`omx cancel`、`omx doctor --team` を使います。

tmux 内で Shift+Enter が改行せず送信する場合は[実行 readiness のトラブルシューティング](../../docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions)を参照してください。多くの場合 tmux terminal capability/discovery の問題です。

### Sparkshell と Wiki

- `omx sparkshell <command>` は shell-native の確認や限定的な検証用です。read-only repository lookup には通常の Codex repository tools/subagents を使います。旧 `omx explore` command は削除されました。
- Sparkshell の primary/fallback 要約 model は既定で `gpt-6-astra`。実行ファイル、model、fallback、instructions file、timeout は該当する `OMX_SPARKSHELL_*` 環境変数で調整できます。
- `omx wiki` は CLI-first JSON surface、`omx_wiki` MCP は互換性用です。データは repo 内 `omx_wiki/` の Markdown で保存し、vector-first ではなく search-first です。

```bash
omx sparkshell git status
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Team mode の platform notes

Team は macOS/Linux + tmux が最適です。ネイティブ Windows は二次的な経路で、Windows ホストでは WSL2 が一般に推奨されます。既存の tmux-backed path では Windows の `psmux` も利用できます。

| Platform | Install |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## 既知の問題

一部の Intel Mac では、起動時に Gatekeeper が多数の process を検証して `syspolicyd` / `trustd` の CPU 使用率が高くなることがあります。次を試してください:

- `xattr -dr com.apple.quarantine $(which omx)`
- macOS Security の Developer Tools allowlist に terminal app を追加
- 同時実行を減らす（例: `--madmax --high` を避ける）

## ドキュメント

- [はじめに](../../docs/getting-started.html) · [Demo](../../DEMO.md) · [Wiki](../../docs/wiki-feature.md) · [Agent catalog](../../docs/agents.html) · [Skills](../../docs/skills.html)
- [Codex native hook mapping](../../docs/codex-native-hooks.md) · [GitHub/PR/package identity pipeline](../../docs/pipeline/github-pr-package-identity.md) · [Integrations](../../docs/integrations.html)
- [トラブルシューティング](../../docs/troubleshooting.md) · [OpenClaw/notification gateway](../openclaw-integration.md) · [Contributing](../../CONTRIBUTING.md) · [Changelog](../../CHANGELOG.md)

## 言語

- [English](../../README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh.md) · [繁體中文](README.zh-TW.md) · [Tiếng Việt](README.vi.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Bahasa Indonesia](README.id.md)

## 追加の起動例

### 目標とワークフロー

```text
# 長い作業向けの永続目標とチェックポイント:
/goal 安全な認証リファクタリング計画を作成・実装し、ログイン、ログアウト、refresh token の動作を検証する。

$deep-interview "認証変更を明確にする"
$ralplan "認証計画を承認し、トレードオフを確認する"
$ultragoal "承認済み計画を永続的な Codex 目標として実行する"
```

```bash
omx --worktree=feat/task --madmax --xhigh
```

### 複数会話と worktree の例

```powershell
$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"
omx
```

```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```

```bash
omx --worktree=feature/auth --madmax --xhigh
```

```bash
omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

### direct 起動と launch policy

```bash
omx --direct --yolo
```

```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

```bash
unset OMX_LAUNCH_POLICY
```

CLI の policy flag は環境変数より優先され、`--` より前の最後の policy flag が適用されます。

```bash
OMX_LAUNCH_POLICY=direct omx --tmux --yolo
```

### checkout 修正の永続目標

```text
# コピーして使える永続目標の例:
/goal 再現、実装、回帰テスト、最終確認のチェックポイントを設けて checkout のバグを修正する。

$plan "checkout バグ修正計画を承認し、トレードオフを確認する"
$ultragoal "チェックポイントの証拠を残しながら承認済み修正を実行する"
```

避けるべきパターン:

```text
omx --madmax --xhigh
# タスクを述べる前に「念のため」スキルを20個読み込む。
# コンテキストを膨らませ、無関係なワークフローに注意を使ってしまう。
```

### 中断した Team の整理

Team が停止済み、または意図的に放棄されたと確認した場合に限り、強制 shutdown を使ってください。

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

### Sparkshell の追加 pane 検査

```bash
omx sparkshell --tmux-pane %12 --tail-lines 400
```

## コントリビューター

| 役割 | 名前 | GitHub |
| --- | --- | --- |
| 制作者・リード | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| メンテナー | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| メンテナー | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## ライセンス

MIT

## GEO visibility benchmark

OMX には、LLM の hit rate、MRR、share of voice、citation を測定する製品仕様 [`geobench`](https://github.com/NomaDamas/geobench) が含まれます。

- 仕様: [`geobench/oh-my-codex.yaml`](../../geobench/oh-my-codex.yaml)
- 実行手順: [`docs/geobench.md`](../../docs/geobench.md)
