# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>你的 codex 并不孤单。</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[OpenClaw 集成指南](../openclaw-integration.zh.md)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

[OpenAI Codex CLI](https://github.com/openai/codex) 的多智能体编排层。

## v0.9.0 新特性 — Spark Initiative

Spark Initiative 是一次强化 OMX 原生探索与检查路径的版本发布。

- **`omx explore` 原生 harness** —— 通过 Rust 原生 harness 更快、更严格地执行只读仓库探索。
- **`omx sparkshell`** —— 面向操作者的原生检查界面，支持长输出摘要与 tmux pane 捕获。
- **跨平台原生发布资产** —— `omx-explore-harness`、`omx-sparkshell` 与 `native-release-manifest.json` 的 hydration 路径现已纳入发布流水线。
- **增强的 CI/CD** —— 为 `build` job 增加显式 Rust toolchain 设置，并加入 `cargo fmt --check` 与 `cargo clippy -- -D warnings`。

详情请参阅 [v0.9.0 发布说明](../release-notes-0.9.0.md) 和 [发布正文](../release-body-0.9.0.md)。

## 首次会话

在 Codex 内部：

```text
$deep-interview "clarify the auth change"
$ralplan "approve the auth plan and review tradeoffs"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

从终端：

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## 推荐工作流

1. `$deep-interview` — 当范围或边界还不清楚时，先用它澄清需求。
2. `$ralplan` — 把澄清后的范围整理成可批准的架构与实施计划。
3. `$team` 或 `$ralph` — 需要协调并行执行时用 `$team`，需要单一负责人持续推进到完成并验证时用 `$ralph`。

## 核心模型

OMX 安装并连接以下层：

```text
User
  -> Codex CLI
    -> AGENTS.md (编排大脑)
    -> ~/.codex/prompts/*.md (代理 prompt 目录)
    -> ~/.codex/skills/*/SKILL.md (skill 目录)
    -> ~/.codex/config.toml (功能、通知、MCP)
    -> .omx/ (运行时状态、记忆、计划、日志)
```

## 主要命令

```bash
omx                # 启动 Codex（在 tmux 中附带 HUD）
omx setup          # 按作用域安装 prompt/skill/config + 项目 .omx + 作用域专属 AGENTS.md
omx doctor         # 安装/运行时诊断
omx doctor --team  # Team/swarm 诊断
omx team ...       # 启动/状态/恢复/关闭 tmux 团队 worker
omx status         # 显示活动模式
omx cancel         # 取消活动执行模式
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test（插件扩展工作流）
omx hud ...        # --watch|--json|--preset
omx help
```

## Hooks 扩展（附加表面）

OMX 现在包含用于插件脚手架和验证的 `omx hooks`。

- `omx tmux-hook` 继续支持且未更改。
- `omx hooks` 是附加的，不会替代 tmux-hook 工作流。
- 插件文件位于 `.omx/hooks/*.mjs`。
- 插件默认关闭；使用 `OMX_HOOK_PLUGINS=1` 启用。

完整的扩展工作流和事件模型请参阅 `docs/hooks-extension.md`。

## 启动标志

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # 仅用于 setup
```

`--madmax` 映射到 Codex `--dangerously-bypass-approvals-and-sandbox`。
仅在可信/外部沙箱环境中使用。

### MCP workingDirectory 策略（可选加固）

默认情况下，MCP state/memory/trace 工具接受调用方提供的 `workingDirectory`。
要限制此行为，请设置允许的根目录列表：

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

设置后，超出这些根目录的 `workingDirectory` 值将被拒绝。

## Codex-First Prompt 控制

默认情况下，OMX 注入：

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

这会将 `CODEX_HOME` 中的 `AGENTS.md` 与项目 `AGENTS.md`（如果存在）合并，然后再附加运行时 overlay。
扩展 Codex 行为，但不会替换/绕过 Codex 核心系统策略。

控制：

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # 禁用 AGENTS.md 注入
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## 团队模式

对于受益于并行 worker 的大规模工作，使用团队模式。

生命周期：

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

操作命令：

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

重要规则：除非中止，否则不要在任务仍处于 `in_progress` 状态时关闭。

### Team shutdown policy

Use `omx team shutdown <team-name>` after the team reaches a terminal state.
Team cleanup now follows one standalone path; legacy linked-Ralph shutdown handling is no longer a separate public workflow.

团队 worker 的 Worker CLI 选择：

```bash
OMX_TEAM_WORKER_CLI=auto    # 默认；当 worker --model 包含 "claude" 时使用 claude
OMX_TEAM_WORKER_CLI=codex   # 强制 Codex CLI worker
OMX_TEAM_WORKER_CLI=claude  # 强制 Claude CLI worker
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # 每个 worker 的 CLI 混合（长度=1 或 worker 数量）
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # 可选：禁用自适应 queue->resend 回退
```

注意：
- Worker 启动参数仍通过 `OMX_TEAM_WORKER_LAUNCH_ARGS` 共享。
- `OMX_TEAM_WORKER_CLI_MAP` 覆盖 `OMX_TEAM_WORKER_CLI` 以实现每个 worker 的选择。
- 触发器提交默认使用自适应重试（queue/submit，需要时使用安全的 clear-line+resend 回退）。
- 在 Claude worker 模式下，OMX 以普通 `claude` 启动 worker（无额外启动参数），并忽略显式的 `--model` / `--config` / `--effort` 覆盖，使 Claude 使用默认 `settings.json`。

## `omx setup` 写入的内容

- `.omx/setup-scope.json`（持久化的设置作用域）
- 依赖作用域的安装：
  - `user`：`~/.codex/prompts/`、`~/.codex/skills/`、`~/.codex/config.toml`、`~/.omx/agents/`、`~/.codex/AGENTS.md`
  - `project`：`./.codex/prompts/`、`./.codex/skills/`、`./.codex/config.toml`、`./.omx/agents/`、`./AGENTS.md`
- 启动行为：如果持久化的作用域是 `project`，`omx` 启动时自动使用 `CODEX_HOME=./.codex`（除非 `CODEX_HOME` 已设置）。
- 启动指令会合并 `~/.codex/AGENTS.md`（或被覆盖的 `CODEX_HOME/AGENTS.md`）与项目 `./AGENTS.md`，然后附加运行时 overlay。
- 现有 `AGENTS.md` 文件绝不会被静默覆盖：交互式 TTY 下 setup 会先询问是否替换；非交互模式下除非传入 `--force`，否则会跳过替换（活动会话安全检查仍然适用）。
- `config.toml` 更新（两种作用域均适用）：
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - MCP 服务器条目（`omx_state`、`omx_memory`、`omx_code_intel`、`omx_trace`）
  - `[tui] status_line`
- 作用域专属 `AGENTS.md`
- `.omx/` 运行时目录和 HUD 配置

## 代理和技能

- Prompt：`prompts/*.md`（`user` 安装到 `~/.codex/prompts/`，`project` 安装到 `./.codex/prompts/`）
- Skill：`skills/*/SKILL.md`（`user` 安装到 `~/.codex/skills/`，`project` 安装到 `./.codex/skills/`）

示例：
- 代理：`architect`、`planner`、`executor`、`debugger`、`verifier`、`security-reviewer`
- 技能：`deep-interview`、`ralplan`、`team`、`ralph`、`plan`、`cancel`

## 项目结构

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

## 开发

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## 文档

- **[完整文档](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — 完整指南
- **[CLI 参考](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — 所有 `omx` 命令、标志和工具
- **[通知指南](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Discord、Telegram、Slack 和 webhook 设置
- **[推荐工作流](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — 用于常见任务的经过实战检验的 skill 链
- **[发行说明](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — 每个版本的新功能

## 备注

- 完整变更日志：`CHANGELOG.md`
- 迁移指南（v0.4.4 后的 mainline）：`docs/migration-mainline-post-v0.4.4.md`
- 覆盖率和对等说明：`COVERAGE.md`
- Hook 扩展工作流：`docs/hooks-extension.md`
- 设置和贡献详情：`CONTRIBUTING.md`

## 致谢

受 [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) 启发，为 Codex CLI 适配。

## 许可证

MIT
