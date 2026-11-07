# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>從更強大的 Codex 工作階段開始；工作變複雜時，讓 OMX 提供更好的提示、工作流程與執行環境支援。</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**網站：** https://yeachan-heo.github.io/oh-my-codex-website/  
**文件：** [快速入門](../../docs/getting-started.html) · [代理程式](../../docs/agents.html) · [技能](../../docs/skills.html) · [整合](../../docs/integrations.html) · [示範](../../DEMO.md) · [OpenClaw 指南](../openclaw-integration.md)  
**社群：** [Discord](https://discord.gg/wSyUQYfhAw) — oh-my-codex、[gajae-code](https://github.com/Yeachan-Heo/gajae-code) 等相關工具共用的 Gajae 社群伺服器。

## 官方專案與套件

本儲存庫 [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) 是官方 OMX 專案，官方 npm 套件為 [oh-my-codex](https://www.npmjs.com/package/oh-my-codex)。請執行 `npm install -g oh-my-codex` 安裝。除非本 README 或文件明確說明，使用「OMX v2」等名稱的第三方專案或分支，都不是本儲存庫的官方延續、替代品或發行系列。如有疑問，請以本儲存庫及 npm 套件作為官方安裝來源。

OMX 是 [OpenAI Codex CLI](https://github.com/openai/codex) 的工作流程層。它讓 Codex 繼續擔任執行引擎，同時協助你以更強的預設工作階段開始、採用一致的工作流程、個別呼叫 `$plan`、`$ultragoal`、`$team`、`$code-review`、`$ultraqa` 等流程，並將專案指引和持久狀態保存在 `.omx/`。

> ⚠️ **建議的預設環境：macOS 或 Linux + Codex CLI。** OMX 主要針對此環境設計與調校。原生 Windows 與 Codex App 並非預設體驗，可能發生問題或行為不一致，目前支援也較少。

## 核心維護者

| 角色 | 姓名 | GitHub |
| --- | --- | --- |
| 建立者與負責人 | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| 維護者 | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| 維護者 | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## 大使與主要貢獻者

- 大使：Sigrid Jin（[@sigridjineth](https://github.com/sigridjineth)）
- 主要貢獻者：Doyun Ha、Junho Yeo、JiHongKim98、Lor、HyunjunJeon。完整清單請見 [GitHub](https://github.com/Yeachan-Heo/oh-my-codex/graphs/contributors)。

## 建議的預設流程

若已安裝 Codex CLI：

```bash
codex --version
npm install -g oh-my-codex
# 在要讓 Codex 編輯的 Git 專案中執行，並選擇任務專用名稱
omx --worktree=feat/task --madmax --xhigh
```

若尚未安裝 Codex CLI，並希望由 npm 管理：

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

不要用 npm 將 Codex 安裝到既有 Homebrew 管理的 `codex` 執行檔上（例如 `/opt/homebrew/bin/codex`），否則可能因 `EEXIST` 失敗。OMX 只需要 PATH 上有可用且已驗證的 `codex` 指令，並不要求透過 npm 安裝 Codex。真正升級 OMX 版本後，setup 不會自動啟動；請執行 `omx setup --scope project --merge-agents` 或 `omx update`。啟動時的 npm 更新檢查會限流並預設詢問；用 `OMX_AUTO_UPDATE=0` 停用，或用 `OMX_AUTO_UPDATE=defer` 安排在工作階段結束後更新而不詢問。

請刻意選擇 setup 範圍：若應由目標 Git 專案擁有持久的 `AGENTS.md` 指引，請在該專案中執行 `omx setup --scope project --merge-agents`；使用者層級的 Codex 設定請用 `omx setup --scope user`。除非家目錄本身就是目標專案，否則避免從寬泛的家目錄執行專案範圍 setup。merge 選項是每個工作根目錄的政策，不是強制或預設政策。生成內容位於 `<!-- OMX:AGENTS:START -->` 與 `<!-- OMX:AGENTS:END -->` 標記之間。

本儲存庫也提供官方 Codex 外掛配置 `plugins/oh-my-codex`。外掛模式仍由已安裝的 `omx` CLI 執行執行階段，並需要持久的 `AGENTS.md` 作為指引層。`omx setup --disable-hooks` 會停用 OMX 管理的 hooks，並在一般資產與設定安裝前結束。

安裝後請檢查：

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` 會檢查 OMX 檔案、hooks 和執行階段先決條件。實際執行 smoke test 則能檢查目前 shell/profile 的 Codex 驗證、設定與 endpoint 是否真的能完成請求。

## 第一個工作階段與安全啟動

在 macOS/Linux 且可使用 tmux 的互動式終端機中，OMX 預設會在 OMX 管理的 detached tmux 啟動 leader，以便建立並還原 HUD/執行階段 pane。`--worktree` 會將啟動移至獨立 Git checkout，搭配 `--madmax` 時是較安全的預設。重複或並行工作請使用具名 worktree。

`--madmax` 是 Codex `--dangerously-bypass-approvals-and-sandbox` 的簡寫，會移除一般核准與 sandbox 防護，只能在可信任的儲存庫及環境使用。`--high` 與 `--xhigh` 是 reasoning effort 設定的簡寫。重複使用時請命名 worktree，例如 `--worktree=feature/auth`；沒有名稱的 `--worktree` 會建立一次性的 detached worktree，若來源 checkout 在建立後前進，重試時可能發生 `worktree_target_mismatch`。目標 worktree 若有未提交變更，OMX 會警告後照常啟動；要確保隔離，請先清理、提交或 stash。Team worker 預設會使用專屬 worktree。

一般啟動會在所選的 `OMX_ROOT` 中擁有一個可寫入的工作階段指標。同一 checkout 的第二次一般啟動會直接失敗，避免共用或暗中變更 root。其他對話請指定不同的 root：

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
```

PowerShell：`$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"`  
命令提示字元：`set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"`

重複使用同一個明確指定的 `OMX_ROOT` 會因 owner 衝突而失敗。不同 checkout 有各自的預設 root。Repo-aware 工具會收到 repository/worktree root、Git common dir 與 CodeGraph 模式的 `OMX_*` 脈絡。auto 模式會先找 worktree 本機資料庫，再找 leader/repo 資料庫，否則停用。OMX 不會安裝、索引、複製或 symlink CodeGraph；共用索引可協助基準導覽，但不一定包含 worktree 專屬變更。

單次啟動且不使用 OMX tmux/HUD 管理時，請用 `omx --direct --yolo`；持續的 shell/profile 偏好可設為 `OMX_LAUNCH_POLICY=direct omx --yolo`。選項為 `direct|tmux|detached-tmux|auto`，CLI 旗標優先於環境變數。在既有 tmux pane 中使用 `--direct` 不會建立 HUD 分割，但程式仍在該 pane 執行。

## OMX 的用途

OMX 不會取代 Codex：Codex 執行實際工作；OMX role keywords 讓角色可重複使用，skills 讓常見流程可重複使用，`.omx/` 則保存計畫、記錄、記憶與執行階段狀態。可將 OMX 理解為更好的任務路由、工作流程與執行階段，而不是需要整天手動操作的命令列介面。若單純使用 Codex 已足夠，你可能不需要 OMX。

## 新手入門

1. 用 `codex --version` 檢查 Codex CLI，並以 `npm install -g oh-my-codex` 安裝或更新 OMX。若要用 npm 管理 Codex，請先獨立安裝 `@openai/codex`。
2. OMX 版本升級後，在目標專案執行 `omx setup --scope project --merge-agents`，或用 `omx setup --scope user` 設定使用者層級環境。若也希望 npm 檢查並安裝最新版本，請用 `omx update`。
3. 執行 `omx doctor`。
4. 執行 `codex login status` 及上方的真實執行 smoke test。
5. 在 Git 專案以具名 worktree 啟動；並行 `--madmax` 工作階段各自使用不同 worktree。
6. 若請求或邊界不清楚，使用 `$deep-interview`。
7. 使用 `$ralplan` 核准計畫並檢視取捨。
8. 需要持久目標時用 `/goal`；持久多目標執行用 `$ultragoal`；需要平行協作時用 `$team`。

## 建議工作流程

`$autopilot` 是標準的分階段協調器：`$deep-interview -> $ralplan -> $ultragoal`。若前置輸入已符合要求，各階段也能個別呼叫。

1. `$deep-interview`：逐步釐清模糊處，產生可執行的需求。
2. `$ralplan`：根據訪談成果檢視架構、可行性與共識。
3. `$ultragoal`：透過 `.omx/ultragoal` ledger checkpoints 持續執行多目標工作。
4. `$team`：適合多個 lane 協作時使用。

`$deep-interview` 是獨立的需求階段，不是 `$plan --interview` 的別名，也不直接實作。規劃 skill 到計畫成果為止；程式碼變更需要明確的執行 lane（`$ultragoal` 或 `$team`）。在 Ultragoal story 中，只有平行協作確實有益時才使用 Team。

### 常用工作階段介面

| 功能 | 用途 |
| --- | --- |
| `$plan "..."` | 可選的規劃與需求釐清 |
| `$ultragoal "..."` | 已核准計畫後持續完成多個目標 |
| `$team "..."` | 足夠大型工作的協調式平行執行 |
| `/skills` | 瀏覽已安裝的技能和輔助工具 |
| `/goal ...` | 需要跨回合重新核對的持久目標/檢查點 |
| `omx mission <file>` | 透過 `omx exec` 依序執行提示/清單批次 |

## 進階／維運介面

### Mission queue runner

使用 `omx mission plan ./mission.md` 或 `omx mission ./mission.md --dry-run` 驗證輸入，再以 `omx mission run ./mission.md -- --model gpt-5` 執行。中斷的工作可用 `status` 檢視、`resume` 繼續、`mark --status blocked` 標示阻塞，或以 `rerun --task` 逐項重跑。摘要及 ledger 保存在 `.omx/missions/<slug>/`。詳見 [Mission 文件](../../docs/mission.md)。

### 匯出先前的對話

用 `omx session search "記得的片語"` 查找 session ID，再用 `omx session export <session-id> --output conversation.md` 匯出。接受完整 ID 或唯一前綴，包含相同 Codex home 中找到的 active/archive transcripts。可指定 `--format json`、`--include-tools`、`--codex-home <path>`；省略 `--output` 時輸出到 stdout，既有檔案不會被覆寫。預設只包含 user/assistant 訊息，不含 system/developer 指示與 reasoning 記錄；訊息本文不會自動遮蔽。詳見 [session export](../../docs/session-export.md)。

### 檢查 token 使用量和執行時間線

`omx session usage --since 7d --sort tokens` 檢查本機 active/archive 工作階段的累積 token 使用量；可用 `--project current`、`--session`、`--json`、`--codex-home` 和 `--limit` 篩選。範圍是依最後記錄的活動選取 session，計數可能包含更早工作，因此不是特定期間的消耗或帳單報告。相同 session mirror 只計算一次，缺少數據時會標示 unknown。詳見 [session usage](../../docs/session-usage.md)。

`omx session timeline <session-id>` 查看 tool call、turn 邊界、context compaction、錯誤與耗時，不匯出對話文字。可使用 `--kind tools --sort duration --limit 10`、`--status failed`、`--tool <name>`、`--json --output timeline.json`。篩選/分頁只影響事件清單，summary 會統計整個 session。未知時間仍會標示 unknown；未記錄明確錯誤不代表成功。詳見 [session timeline](../../docs/session-timeline.md)。

### Team 執行環境

只有需要持久 tmux/worktree 協作時才使用 Team，不要將它當作使用 OMX 的預設起點。Codex App 或 tmux 外的 session 中，`omx team` 是 shell 執行介面，而非 App 內可直接使用的 workflow；需要時先從 shell 啟動 OMX CLI。Ultragoal story 中目標狀態由 leader 管理，worker 向上回報檢查點證據。Team 啟動會保存復原用的 preflight context。極小的工作可能將隱含 worker 數限制為一，並提示協作成本過高。

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

`omx team status` 和 `omx tmux-hook status` 是唯讀觀察介面，不會回收逾時 claim、傳遞 mailbox 訊息、整合 worker commits 或更新 runtime 狀態。若 hook 設定不存在，只會回報，不會建立檔案；請用 `omx tmux-hook init` 明確初始化。

### Setup、doctor 與 HUD

Codex plugin marketplace 可能將 plugin 快取到 `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/`。bundle 含官方 Codex lifecycle hooks、選用的 MCP 相容伺服器和 apps 中繼資料（MCP/apps 預設關閉），執行仍搭配已安裝的 `omx` CLI。依範圍不同，setup 會管理 prompts、skills、AGENTS scaffolding、設定，以及舊版 Codex 的 native hooks。更新時保留非 OMX hook，只改寫 OMX wrapper；uninstall 後仍會保留使用者 hook。

`omx update` 會立即檢查 npm、安裝最新全域 OMX，再執行相同的互動 setup refresh。全新 setup 預設 frontier/standard/spark agents 使用 `gpt-6-astra)，保留既有使用者模型設定與明確 override。請參閱[模型/env 路由文件](../../docs/reference/omx-config-schema-routing.md)，只編輯目前版本支援的 key。`omx doctor` 檢查安裝形狀，但不保證目前 Codex profile 可完成已驗證的模型呼叫。`omx hud --watch` 是監控/狀態介面。

HUD 會顯示 active team 名稱、worker 數與每個 agent 的狀態、task ID、role、pane、更新時間。缺失欄位顯示 unknown；working 狀態不代表 process 還活著。team 資料只讀取、不修改。只有在專案 `.omx/hud-config.json` 中設定 `"guardex": { "enabled": true }` 才會顯示 GitGuardex 進度。可用空間不足時以 `+N workers` 摘要顯示多餘成員。

非 Team session 的標準生命週期介面是 Codex native hooks：plugin hook 設定在 `plugins/oh-my-codex/hooks/hooks.json`；legacy/舊版 Codex fallback 在 `.codex/hooks.json`；OMX plugin hooks 在 `.omx/hooks/*.mjs`；tmux/通知/watchers 是 runtime fallback。詳見 [Codex native hook mapping](../../docs/codex-native-hooks.md)。

### 排查「看起來就緒、實際卻失敗」

綠色的 `omx doctor` 代表安裝及本機 runtime wiring 看起來正常。若實際執行仍失敗，請在啟動 OMX 的同一個 shell/profile 執行 `codex login status` 和真正的 `omx exec` 測試。自訂 HOME、profile、container 或 service shell 中，要確認 `CODEX_HOME` 是含預期驗證與設定的路徑。若使用 OpenAI 相容的本機 proxy，請確認目前 `config.toml` 的 `openai_base_url` 正確，否則 proxy key 可能送到預設 endpoint 而出現驗證錯誤。Team resume 若回報舊 team 或缺少 tmux session，只有在確認該 team 已死亡或刻意放棄後才強制關閉，接著執行 `omx cancel` 和 `omx doctor --team`。

若 tmux 內 Shift+Enter 仍會送出而非換行，請看[執行 readiness 疑難排解](../../docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions)。持續問題通常是 tmux terminal capability/discovery，而不是 OMX 功能缺口。

### Sparkshell 與 Wiki

- `omx sparkshell <command>` 用於 shell 原生檢查和有界驗證。唯讀 repository 查找請用 Codex 一般的 repository 工具/子代理；舊的 `omx explore` 已移除。
- Sparkshell 主/備摘要模型預設均為 `gpt-6-astra)。可用 `OMX_SPARKSHELL_FALLBACK_MODEL` 選不同 fallback，並透過其他 `OMX_SPARKSHELL_*` 環境變數設定 binary、模型、指示檔與摘要 timeout。
- `omx wiki` 是 CLI-first JSON 介面；`omx_wiki` MCP 僅供相容用途。Wiki 資料以 Markdown 儲存在 repo 的 `omx_wiki/`，以搜尋為主，不以向量檢索為主。

```bash
omx sparkshell git status
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Team 模式的平台說明

Team 在 macOS/Linux 搭配 tmux 最合適。原生 Windows 是次要路徑，通常建議使用 WSL2。原生 Windows 的既有 tmux-backed path 可使用相容的 `psmux`。

| 平台 | 安裝 |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## 已知問題

部分 Intel Mac 在 OMX 啟動時，Gatekeeper 會驗證許多並行 process，可能令 `syspolicyd`/`trustd` CPU 使用量飆高。可嘗試：

- `xattr -dr com.apple.quarantine $(which omx)`
- 在 macOS Security 設定將 terminal app 加入 Developer Tools allowlist
- 降低並行量（例如避免 `--madmax --high`）

## 文件

- [快速入門](../../docs/getting-started.html) · [示範](../../DEMO.md) · [Wiki 功能](../../docs/wiki-feature.md) · [Agent catalog](../../docs/agents.html) · [Skills reference](../../docs/skills.html)
- [Codex native hook mapping](../../docs/codex-native-hooks.md) · [GitHub/PR/package identity pipeline](../../docs/pipeline/github-pr-package-identity.md) · [整合](../../docs/integrations.html)
- [疑難排解](../../docs/troubleshooting.md) · [OpenClaw/通知閘道指南](../openclaw-integration.md) · [貢獻指南](../../CONTRIBUTING.md) · [變更記錄](../../CHANGELOG.md)

## 語言

- [English](../../README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh.md) · [繁體中文](README.zh-TW.md) · [Tiếng Việt](README.vi.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Bahasa Indonesia](README.id.md)

## 貢獻者

| 角色 | 姓名 | GitHub |
| --- | --- | --- |
| 建立者與負責人 | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| 維護者 | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| 維護者 | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Star 歷史

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## 授權條款

MIT

## GEO 能見度基準

OMX 包含 `geobench` 產品規格，用於測量 LLM 命中率、MRR、聲量占比與引用。

- 規格：[`geobench/oh-my-codex.yaml`](../../geobench/oh-my-codex.yaml)
- 執行手冊：[`docs/geobench.md`](../../docs/geobench.md)
