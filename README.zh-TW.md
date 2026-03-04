# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>你的 Codex，從不孤行。</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[官方網站](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[說明文件](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI 參考手冊](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[工作流程](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

[OpenAI Codex CLI](https://github.com/openai/codex) 的多智能體編排層。

## 語言

- [English](./README.md)
- [한국어 (Korean)](./README.ko.md)
- [日本語 (Japanese)](./README.ja.md)
- [简体中文 (Chinese Simplified)](./README.zh.md)
- [繁體中文 (Chinese Traditional)](./README.zh-TW.md)
- [Tiếng Việt (Vietnamese)](./README.vi.md)
- [Español (Spanish)](./README.es.md)
- [Português (Portuguese)](./README.pt.md)
- [Русский (Russian)](./README.ru.md)
- [Türkçe (Turkish)](./README.tr.md)
- [Deutsch (German)](./README.de.md)
- [Français (French)](./README.fr.md)
- [Italiano (Italian)](./README.it.md)


OMX 讓 Codex 從單一會話代理進化為協同運作的系統，具備以下能力：
- 角色提示詞 (`/prompts:name`)，賦予代理各司其職的專業特質
- 工作流程技能 (`$name`)，實現可重複執行的作業模式
- 透過 tmux 互動模式（預設）或非 tmux 提示模式進行團隊編排 (`omx team`、`$team`)
- 透過 MCP 伺服器實現持久化狀態與記憶

## 為何選擇 OMX

Codex CLI 擅長處理直接明確的任務。OMX 為更大規模的工作注入結構：
- 分解任務並分階段執行 (`team-plan -> team-prd -> team-exec -> team-verify -> team-fix`)
- 持久化的模式生命週期狀態 (`.omx/state/`)
- 長時間運行會話所需的記憶與備忘錄介面
- 啟動、驗證與取消的作業控制

OMX 是插件，而非分支版本。它完全運用 Codex 的原生擴充點。

## 定位：CLI 優先的編排層，MCP 支援的狀態管理

OMX 最適合作為**外層 CLI 編排層**使用：
- **控制平面（CLI/執行期）：** `omx team`、tmux 工作進程、生命週期指令
- **能力/狀態平面（MCP）：** 任務狀態、信箱、記憶、診斷工具

實際模式分工：
- **`$team` / `omx team`**：耐久、可檢視、可恢復的多工作進程執行
- **`$ultrawork`**：針對獨立任務的輕量平行扇出（元件模式）

低 Token 消耗的團隊設定範例：

```bash
OMX_TEAM_WORKER_CLI=codex \
OMX_TEAM_WORKER_LAUNCH_ARGS='--model gpt-5.3-codex-spark -c model_reasoning_effort="low"' \
omx team 2:explore "短暫有界的分析任務"
```

## 系統需求

- macOS 或 Linux（Windows 可透過 WSL2 使用）
- Node.js >= 20（CI 驗證 Node 20 及目前 LTS，目前為 Node 22）
- 已安裝 Codex CLI（`npm install -g @openai/codex`）
- 已完成 Codex 身份驗證設定

## 快速入門（3 分鐘）

```bash
npm install -g oh-my-codex
omx setup
omx doctor
```

推薦的信任環境啟動設定：

```bash
omx --xhigh --madmax
```

## v0.5.0 新功能

- 透過 `omx setup --scope user|project` 實現**範圍感知設定** — 彈性的安裝模式。
- 透過 `--spark` / `--madmax-spark` 實現 **Spark 工作進程路由** — 團隊工作進程可使用 `gpt-5.3-codex-spark`，無需強制套用領導者模型。
- **目錄整合** — 移除已棄用的提示詞（`deep-executor`、`scientist`）及 9 個已棄用的技能，讓介面更為精簡。
- **通知詳細程度等級** — 對 CCNotifier 輸出進行精細控制。

## 首次會話

在 Codex 內部：

```text
/prompts:architect "analyze current auth boundaries"
/prompts:executor "implement input validation in login"
$plan "ship OAuth callback safely"
$team 3:executor "fix all TypeScript errors"
```

從終端機：

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## 核心模型

OMX 安裝並串接以下各層：

```text
使用者
  -> Codex CLI
    -> AGENTS.md（編排大腦）
    -> ~/.codex/prompts/*.md（代理提示詞目錄）
    -> ~/.agents/skills/*/SKILL.md（技能目錄）
    -> ~/.codex/config.toml（功能、通知、MCP）
    -> .omx/（執行期狀態、記憶、計畫、日誌）
```

## 主要指令

```bash
omx                  # 啟動 Codex（可用時在 tmux 中附帶 HUD）
omx setup            # 依範圍安裝提示詞/技能/設定 + 專案 AGENTS.md/.omx
omx doctor           # 安裝/執行期診斷
omx doctor --team    # 團隊/群集診斷
omx ask ...          # 詢問本地供應商顧問（claude|gemini），結果寫入 .omx/artifacts/*
omx team ...         # 啟動/狀態/恢復/關閉團隊工作進程（預設為互動式 tmux）
omx status           # 顯示目前活動模式
omx cancel           # 取消活動中的執行模式
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...    # init|status|validate|test
omx hooks ...        # init|status|validate|test（插件擴充工作流程）
omx hud ...          # --watch|--json|--preset
omx help
```

Ask 指令範例：

```bash
omx ask claude "review this diff"
omx ask gemini "brainstorm alternatives"
omx ask claude --agent-prompt executor "implement feature X with tests"
omx ask gemini --agent-prompt=planner --prompt "draft a rollout plan"
# 底層供應商 CLI 說明中的旗標：
# claude -p|--print "<prompt>"
# gemini -p|--prompt "<prompt>"
```

非 tmux 團隊啟動（進階）：

```bash
OMX_TEAM_WORKER_LAUNCH_MODE=prompt omx team 2:executor "task"
```

## Hooks 擴充（附加介面）

OMX 現已包含 `omx hooks`，用於插件鷹架建立與驗證。

- `omx tmux-hook` 持續受支援，行為不變。
- `omx hooks` 屬於附加功能，不會取代 tmux-hook 工作流程。
- 插件檔案位於 `.omx/hooks/*.mjs`。
- 插件預設關閉；使用 `OMX_HOOK_PLUGINS=1` 啟用。

完整的擴充工作流程與事件模型，請參閱 `docs/hooks-extension.md`。

## 啟動旗標

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # 僅用於 setup
```

`--madmax` 對應 Codex 的 `--dangerously-bypass-approvals-and-sandbox`。
僅在信任環境或外部沙箱環境中使用。

### MCP workingDirectory 策略（選用強化）

預設情況下，MCP 狀態/記憶/追蹤工具接受呼叫方提供的 `workingDirectory`。
若要限制此行為，請設定允許的根目錄清單：

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

設定後，超出這些根目錄的 `workingDirectory` 值將被拒絕。

## Codex 優先的提示詞控制

預設情況下，OMX 注入：

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

這會將專案的 `AGENTS.md` 指引加入 Codex 啟動指令中。
此舉擴充了 Codex 的行為，但不會取代或繞過 Codex 核心系統策略。

控制方式：

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # 停用 AGENTS.md 注入
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## 團隊模式

對於能從平行工作進程獲益的大規模工作，請使用團隊模式。

生命週期：

```text
啟動 -> 分配有界通道 -> 監控 -> 驗證終端任務 -> 關閉
```

作業指令：

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

重要規則：除非要中止，否則請勿在任務仍處於 `in_progress` 狀態時關閉。

### Ralph 清理策略

當團隊以 ralph 模式執行（`omx team ralph ...`）時，關閉清理
會套用與一般路徑不同的專屬策略：

| 行為 | 一般團隊 | Ralph 團隊 |
|---|---|---|
| 失敗時強制關閉 | 拋出 `shutdown_gate_blocked` | 略過閘門，記錄 `ralph_cleanup_policy` 事件 |
| 自動刪除分支 | 復原時刪除 worktree 分支 | 保留分支（`skipBranchDeletion`） |
| 完成日誌 | 標準 `shutdown_gate` 事件 | 附帶任務分解的 `ralph_cleanup_summary` 事件 |

Ralph 策略會從團隊模式狀態（`linked_ralph`）自動偵測，
也可透過 `omx team shutdown <name> --ralph` 明確傳遞。

團隊工作進程的 Worker CLI 選擇：

```bash
OMX_TEAM_WORKER_CLI=auto    # 預設；當 worker --model 包含 "claude" 時使用 claude
OMX_TEAM_WORKER_CLI=codex   # 強制使用 Codex CLI 工作進程
OMX_TEAM_WORKER_CLI=claude  # 強制使用 Claude CLI 工作進程
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # 每個工作進程的 CLI 混合（長度為 1 或等於工作進程數量）
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # 選用：停用自適應 queue->resend 回退機制
```

注意事項：
- 工作進程啟動參數仍透過 `OMX_TEAM_WORKER_LAUNCH_ARGS` 共享。
- `OMX_TEAM_WORKER_CLI_MAP` 會覆寫 `OMX_TEAM_WORKER_CLI`，以實現每個工作進程的個別選擇。
- 觸發提交預設使用自適應重試（queue/submit，必要時採用安全的清除行 + 重傳回退）。
- 在 Claude 工作進程模式下，OMX 以純 `claude` 啟動工作進程（無額外啟動參數），並忽略明確的 `--model` / `--config` / `--effort` 覆寫，讓 Claude 使用預設的 `settings.json`。

## `omx setup` 寫入的內容

- `.omx/setup-scope.json`（持久化的設定範圍）
- 依範圍的安裝內容：
  - `user`：`~/.codex/prompts/`、`~/.agents/skills/`、`~/.codex/config.toml`、`~/.omx/agents/`
  - `project`：`./.codex/prompts/`、`./.agents/skills/`、`./.codex/config.toml`、`./.omx/agents/`
- 啟動行為：若持久化範圍為 `project`，`omx` 啟動時自動使用 `CODEX_HOME=./.codex`（除非已設定 `CODEX_HOME`）。
- 現有的 `AGENTS.md` 預設會保留。在互動式 TTY 執行時，setup 會在覆寫前詢問確認；`--force` 則不詢問直接覆寫（仍適用活動會話安全檢查）。
- `config.toml` 更新（兩種範圍均適用）：
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - MCP 伺服器項目（`omx_state`、`omx_memory`、`omx_code_intel`、`omx_trace`）
  - `[tui] status_line`
- 專案 `AGENTS.md`
- `.omx/` 執行期目錄與 HUD 設定

## 代理與技能

- 提示詞：`prompts/*.md`（`user` 安裝至 `~/.codex/prompts/`，`project` 安裝至 `./.codex/prompts/`）
- 技能：`skills/*/SKILL.md`（`user` 安裝至 `~/.agents/skills/`，`project` 安裝至 `./.agents/skills/`）

範例：
- 代理：`architect`、`planner`、`executor`、`debugger`、`verifier`、`security-reviewer`
- 技能：`autopilot`、`plan`、`team`、`ralph`、`ultrawork`、`cancel`

### 視覺品管迴圈（`$visual-verdict`）

當任務需要視覺保真度驗證（參考圖片 + 生成截圖）時，請使用 `$visual-verdict`。

- 回傳結構化 JSON：`score`、`verdict`、`category_match`、`differences[]`、`suggestions[]`、`reasoning`
- 建議通過門檻：**90 分以上**
- 對於視覺任務，在每次下一輪編輯前先執行 `$visual-verdict`
- 使用像素差異 / pixelmatch 疊加圖作為**輔助除錯工具**（而非主要通過/失敗判斷依據）

## 專案結構

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

## 開發

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run lint
npm run build
npm test
```

## 說明文件

- **[完整說明文件](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — 完整指南
- **[CLI 參考手冊](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — 所有 `omx` 指令、旗標與工具
- **[通知設定指南](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Discord、Telegram、Slack 及 Webhook 設定
- **[推薦工作流程](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — 實戰驗證的技能鏈，適用常見任務
- **[版本發行說明](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — 每個版本的新功能

## 附註

- 完整變更日誌：`CHANGELOG.md`
- 遷移指南（v0.4.4 後的主線版本）：`docs/migration-mainline-post-v0.4.4.md`
- 覆蓋率與同等性說明：`COVERAGE.md`
- Hook 擴充工作流程：`docs/hooks-extension.md`
- 設定與貢獻詳情：`CONTRIBUTING.md`

## 致謝

靈感來自 [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)，為 Codex CLI 量身改編。

## 授權條款

MIT
