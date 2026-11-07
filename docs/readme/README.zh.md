# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>从更强大的 Codex 会话开始；任务变复杂时，让 OMX 提供更好的提示、工作流和运行时支持。</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**网站：** https://yeachan-heo.github.io/oh-my-codex-website/  
**文档：** [快速入门](../../docs/getting-started.html) · [代理](../../docs/agents.html) · [技能](../../docs/skills.html) · [集成](../../docs/integrations.html) · [演示](../../DEMO.md) · [OpenClaw 指南](../openclaw-integration.md)  
**社区：** [Discord](https://discord.gg/wSyUQYfhAw) — oh-my-codex、[gajae-code](https://github.com/Yeachan-Heo/gajae-code) 等相关工具的 Gajae 社区服务器。

## 官方项目与软件包

本仓库 [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) 是官方 OMX 项目，官方 npm 软件包是 [oh-my-codex](https://www.npmjs.com/package/oh-my-codex)。请运行 `npm install -g oh-my-codex` 安装。除非本 README 或文档明确说明，使用“OMX v2”等名称的第三方项目或分支都不是本仓库的官方后续项目、替代品或发行系列。如有疑问，请以本仓库和 npm 软件包作为官方安装来源。

OMX 是 [OpenAI Codex CLI](https://github.com/openai/codex) 的工作流层。它保留 Codex 作为执行引擎，同时帮助你启动更强的默认会话、使用一致的工作流、独立调用 `$plan`、`$ultragoal`、`$team`、`$code-review`、`$ultraqa` 等工作流，并将项目指导和持久状态保存在 `.omx/` 中。

> ⚠️ **推荐默认环境：macOS 或 Linux + Codex CLI。** OMX 主要围绕此环境设计和调优。原生 Windows 和 Codex App 并非默认体验，可能出现故障或行为不一致，目前支持也较少。

## 核心维护者

| 角色 | 姓名 | GitHub |
| --- | --- | --- |
| 创建者与负责人 | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| 维护者 | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| 维护者 | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## 大使与主要贡献者

- 大使：Sigrid Jin（[@sigridjineth](https://github.com/sigridjineth)）
- 主要贡献者：Doyun Ha、Junho Yeo、JiHongKim98、Lor、HyunjunJeon。完整名单见 [GitHub](https://github.com/Yeachan-Heo/oh-my-codex/graphs/contributors)。

## 推荐默认流程

如果已安装 Codex CLI：

```bash
codex --version
npm install -g oh-my-codex
# 在要让 Codex 编辑的 Git 项目中运行；请选一个任务专用名称
omx --worktree=feat/task --madmax --xhigh
```

如果还没有 Codex CLI，并希望由 npm 管理：

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

不要用 npm 在现有 Homebrew 管理的 `codex` 二进制文件（例如 `/opt/homebrew/bin/codex`）上安装 Codex；这可能因 `EEXIST` 而失败。OMX 只要求 PATH 中有可用且已认证的 `codex` 命令，并不要求 Codex 由 npm 安装。真正升级 OMX 版本后，setup 不会自动启动；请运行 `omx setup --scope project --merge-agents` 或 `omx update`。启动时的 npm 更新检查会节流并在安装前询问；用 `OMX_AUTO_UPDATE=0` 禁用，或用 `OMX_AUTO_UPDATE=defer` 安排会话退出后更新且不询问。

请谨慎选择 setup 范围：要让目标 Git 项目拥有持久的 `AGENTS.md` 指导，请在项目中运行 `omx setup --scope project --merge-agents`；用户级 Codex 配置使用 `omx setup --scope user`。除非宽泛的 home 目录本身就是目标项目，否则不要从该目录运行项目级 setup。merge 选项是按工作根目录保存的策略，不是强制或默认策略。生成的 OMX 内容位于 `<!-- OMX:AGENTS:START -->` 与 `<!-- OMX:AGENTS:END -->` 标记之间。

本仓库还提供官方 Codex 插件布局 `plugins/oh-my-codex`。插件模式仍使用已安装的 `omx` CLI 执行运行时，并需要持久的 `AGENTS.md` 作为指导层。`omx setup --disable-hooks` 会禁用 OMX 自有 hook，并在安装其他资源和配置前退出。

安装后检查：

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` 检查 OMX 文件、hook 和运行时依赖。实际执行 smoke test 则验证当前 shell/profile 中的 Codex 认证、配置和 endpoint 是否能完成真实请求。

## 首次会话与安全启动

在可用 tmux 的 macOS/Linux 交互终端中，OMX 默认会在其管理的 detached tmux 中启动 leader，以便创建和恢复 HUD/运行时 pane。`--worktree` 会将启动放在单独的 Git checkout 中，与 `--madmax` 搭配时更安全。重复或并发任务请使用命名 worktree。

`--madmax` 是 Codex `--dangerously-bypass-approvals-and-sandbox` 的简写，会移除正常审批和沙箱保护，只能在可信仓库和环境中使用。`--high` 与 `--xhigh` 是 reasoning effort 设置的简写。使用 `--worktree=feature/auth` 等名称来重复使用 worktree；不带名称的 `--worktree` 会创建临时 detached worktree，若源 checkout 在其创建后前进，重试可能发生 `worktree_target_mismatch`。目标 worktree 若有未提交更改，OMX 会警告后照常启动；如需隔离，请先清理、提交或 stash。Team worker 默认拥有独立 worktree。

普通启动会在所选 `OMX_ROOT` 中占用一个可写 session pointer。同一 checkout 中的第二个普通启动会失败，以免共享或悄悄改写该 root。请给其他会话指定独立 root：

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
OMX_ROOT="$HOME/.omx/instances/third-conversation" omx
```

PowerShell：`$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"`  
命令提示符：`set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"`

多次使用同一个显式 `OMX_ROOT` 会因 owner 冲突而失败；不同 checkout 有独立默认 root。Repo-aware 工具会收到 repo/worktree root、Git common dir 和 CodeGraph 模式相关的 `OMX_*` 上下文。auto 模式优先使用 worktree 本地数据库，其次是 leader/repo 数据库，否则关闭。OMX 不会安装、自动索引、复制或链接 CodeGraph；共享索引可用于基线导航，但不一定反映 worktree 独有更改。

单次启动且不使用 OMX tmux/HUD 管理时运行 `omx --direct --yolo`；持久 shell 选项可设为 `OMX_LAUNCH_POLICY=direct omx --yolo`。可选策略为 `direct|tmux|detached-tmux|auto`，CLI 标志优先于环境变量。若在已有 tmux pane 中使用 `--direct`，OMX 不会创建 HUD 分屏，但进程仍在该 pane 中运行。

## OMX 的作用

OMX 不会取代 Codex：Codex 执行实际工作；OMX role keyword 让角色可复用，skill 让常见工作流可复用，而 `.omx/` 保存计划、日志、记忆和运行时状态。可以把 OMX 理解为更好的任务路由、工作流和运行时，而不是一组需要整天手动操作的命令。如果纯 Codex 已经满足需求，你可能不需要 OMX。

## 新手入门

1. 用 `codex --version` 验证 Codex CLI，用 `npm install -g oh-my-codex` 安装或更新 OMX；若希望 npm 管理 Codex，请先单独安装 `@openai/codex`。
2. OMX 版本升级后，在目标项目中运行 `omx setup --scope project --merge-agents`，或用 `omx setup --scope user` 配置用户级环境；还希望 npm 检查并安装最新版本时用 `omx update`。
3. 运行 `omx doctor`。
4. 运行 `codex login status` 及上方的真实执行 smoke test。
5. 在 Git 仓库中使用命名 worktree 启动；并发 `--madmax` 会话各用独立 worktree。
6. 请求或边界尚不清楚时使用 `$deep-interview`。
7. 用 `$ralplan` 审批计划并审视取舍。
8. 需要跨回合持久目标时用 `/goal`；持久多目标执行用 `$ultragoal`；需要并行协调时用 `$team`。

## 推荐工作流

`$autopilot` 是标准分阶段编排器，默认流程为 `$deep-interview -> $ralplan -> $ultragoal`。如果前置输入已满足，每个阶段也可单独调用。

1. `$deep-interview`：迭代澄清歧义，生成可执行需求。
2. `$ralplan`：基于访谈成果审查架构、可行性并达成共识。
3. `$ultragoal`：借助 `.omx/ultragoal` ledger checkpoints 执行持久多目标工作。
4. `$team`：任务确实适合多个 lane 协作时使用。

`$deep-interview` 是独立需求阶段，不是 `$plan --interview` 的别名，也不会直接实现。规划技能止于计划产物；代码变更需要明确的执行 lane（`$ultragoal` 或 `$team`）。在 Ultragoal story 内，仅当并行协调确有收益时才启动 Team。

### 常用会话功能

| 功能 | 用途 |
| --- | --- |
| `$plan "..."` | 可选规划和需求澄清 |
| `$ultragoal "..."` | 已审批计划后的持久多目标完成 |
| `$team "..."` | 足够大型工作的协调并行执行 |
| `/skills` | 浏览已安装技能和辅助工具 |
| `/goal ...` | 跨回合跟踪的持久目标/检查点 |
| `omx mission <file>` | 通过 `omx exec` 顺序执行提示/检查清单批次 |

## 高级/运维功能

### Mission 队列

用 `omx mission plan ./mission.md` 或 `omx mission ./mission.md --dry-run` 验证输入，再用 `omx mission run ./mission.md -- --model gpt-5` 执行。中断后可用 `status` 检查、`resume` 继续、`mark --status blocked` 标记阻塞、`rerun --task` 单独重跑。摘要和 ledger 保存在 `.omx/missions/<slug>/`。详见 [Mission 文档](../../docs/mission.md)。

### 导出先前会话

用 `omx session search "记得的一段话"` 查找 session ID，再用 `omx session export <session-id> --output conversation.md` 导出。支持精确 ID 或唯一前缀，包含搜索发现的 Codex home 中的活动及归档 transcript。可选 `--format json`、`--include-tools` 或 `--codex-home <path>`；省略 `--output` 时写入 stdout，已有输出文件不会覆盖。默认只导出 user/assistant 消息，不包含 system/developer 指令和 reasoning 记录；消息文本不会自动脱敏。详见 [session export](../../docs/session-export.md)。

### 查看 token 用量和执行时间线

`omx session usage --since 7d --sort tokens` 查看本地活动及归档会话的累积 token 用量；可用 `--project current`、`--session`、`--json`、`--codex-home` 和 `--limit` 过滤。时间范围按最后记录的活动选择会话，计数可能包括更早工作，因此不是指定时间段的消耗/账单报告。相同 session 镜像只计算一次，缺失测量显示为 unknown。详见 [session usage](../../docs/session-usage.md)。

`omx session timeline <session-id>` 查看 tool call、turn 边界、context compaction、错误和时长，不导出会话文本。可用 `--kind tools --sort duration --limit 10`、`--status failed`、`--tool <name>`、`--json --output timeline.json`。筛选/分页只影响事件列表，summary 统计整个 session。未知时长仍标为 unknown；没有明确错误不代表执行成功。详见 [session timeline](../../docs/session-timeline.md)。

### Team 运行时

仅在需要持久 tmux/worktree 协调时使用 Team，不要把它当作默认起点。在 Codex App 或 tmux 外的普通会话中，`omx team` 是 shell runtime 功能，不是可直接在 App 中使用的流程；需要时先从 shell 启动 OMX CLI。Ultragoal story 中的 Ultragoal 状态由 leader 管理，worker 向上报告检查点证据。启动会保存恢复所需的 preflight context。极小的原子任务可能将隐式并行数限制为一个并提示过度编排。

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

`omx team status` 和 `omx tmux-hook status` 只读取现有状态，不会回收过期 claim、传递 mailbox 消息、集成 worker commit 或更改运行时状态。hook 配置缺失时只会报告，不会创建文件；显式初始化请用 `omx tmux-hook init`。

### Setup、doctor 与 HUD

Codex plugin marketplace 可将插件缓存到 `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/`。插件包含官方 Codex 生命周期 hook、可选 MCP 兼容服务器和 apps 的伴随元数据（MCP/apps 默认关闭），运行时仍配合已安装的 `omx` CLI。按安装范围，setup 管理 prompts、skills、AGENTS scaffolding、配置及旧版/不支持 `plugin_hooks` 的 Codex hook。setup refresh 保留用户 hook，只重写 OMX 管理的 wrapper；卸载时仍保留用户 hook。

`omx update` 立即检查 npm、安装最新全局 OMX，再运行同一交互式 setup refresh。全新 setup 默认对 frontier/standard/spark agent 使用 `gpt-6-astra`，并保留现有用户配置和显式 override。请查阅[模型/env 路由参考](../../docs/reference/omx-config-schema-routing.md)，只编辑已安装版本支持的设置。`omx doctor` 检查安装状态，但不能证明当前 Codex profile 能完成认证请求。`omx hud --watch` 是状态监控界面。

活动 Team 在每种 HUD preset 中显示 team 名称、worker 数及 agent 的状态、task ID、role、tmux pane 和更新时间。未知字段显示为 unknown；显示 working 不代表进程仍存活。数据以只读方式读取。GitGuardex 进度仅在项目 `.omx/hud-config.json` 中启用 `"guardex": { "enabled": true }` 后显示。HUD 按终端空间调整，放不下的成员合并为 `+N workers`。

非 Team 会话以 Codex native hooks 为标准：插件 hook 注册位于 `plugins/oh-my-codex/hooks/hooks.json`；旧安装/旧版 Codex 的 fallback 在 `.codex/hooks.json`；OMX plugin hook 位于 `.omx/hooks/*.mjs`；tmux/通知/watcher 是运行时 fallback。详见 [Codex native hook mapping](../../docs/codex-native-hooks.md)。

### 排查“看起来就绪但实际失败”

绿色的 `omx doctor` 只说明安装与本地运行配置正常。若执行失败，请在启动 OMX 的同一 shell/profile 中运行 `codex login status` 和实际 `omx exec` 测试。自定义 HOME、profile、container 或 service shell 中要确认 `CODEX_HOME` 指向预期的认证和配置。使用 OpenAI-compatible 本地代理时，检查当前 `config.toml` 是否有正确的 `openai_base_url`，否则代理 key 可能被送往默认 endpoint 并导致认证错误。若 Team resume 报告过期 team 或缺少 tmux session，仅在确认该 team 已死亡或放弃后才强制关闭，再运行 `omx cancel` 和 `omx doctor --team`。

若 tmux 中 Shift+Enter 仍会提交而不是换行，请查看[执行 readiness 故障排查](../../docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions)。持久问题通常是 tmux terminal capability/discovery，而非 OMX 缺少功能。

### Sparkshell 与 Wiki

- `omx sparkshell <command>` 用于 shell 原生检查和有界验证。只读仓库查找应使用 Codex 通常的仓库工具/子代理；已移除旧的 `omx explore` 命令。
- Sparkshell 的主/备用摘要模型默认均为 `gpt-6-astra`；可用 `OMX_SPARKSHELL_FALLBACK_MODEL` 设置不同备用模型，并用其他 `OMX_SPARKSHELL_*` 变量设置二进制、模型、指令文件和摘要超时。
- `omx wiki` 是 CLI-first JSON 接口；`omx_wiki` MCP 仅用于兼容。Wiki 存于仓库 `omx_wiki/`，以 Markdown 和搜索为主，不以向量搜索为主。

```bash
omx sparkshell git status
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Team 模式平台说明

Team 在 macOS/Linux + tmux 上体验最佳。原生 Windows 是次要路径，Windows 环境通常更适合 WSL2。原生 Windows 的既有 tmux-backed 路径可使用兼容二进制 `psmux`。

| 平台 | 安装 |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## 已知问题

部分 Intel Mac 在启动 OMX 时，macOS Gatekeeper 并发验证许多进程，可能令 `syspolicyd`/`trustd` CPU 占用升高。可尝试：

- `xattr -dr com.apple.quarantine $(which omx)`
- 在 macOS 安全设置中将终端应用添加到 Developer Tools 允许列表
- 降低并发度（例如避免 `--madmax --high`）

## 文档

- [快速入门](../../docs/getting-started.html) · [演示](../../DEMO.md) · [Wiki 功能](../../docs/wiki-feature.md) · [代理目录](../../docs/agents.html) · [技能参考](../../docs/skills.html)
- [Codex native hook mapping](../../docs/codex-native-hooks.md) · [GitHub/PR/package identity pipeline](../../docs/pipeline/github-pr-package-identity.md) · [集成](../../docs/integrations.html)
- [故障排查](../../docs/troubleshooting.md) · [OpenClaw/通知网关指南](../openclaw-integration.md) · [贡献指南](../../CONTRIBUTING.md) · [更新日志](../../CHANGELOG.md)

## 语言

- [English](../../README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh.md) · [繁體中文](README.zh-TW.md) · [Tiếng Việt](README.vi.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Bahasa Indonesia](README.id.md)

## 更多启动示例

### 目标与工作流

```text
# 适用于长期任务的持久目标与检查点：
/goal 制定并实现安全的身份验证重构计划，并验证登录、登出和 refresh token 行为。

$deep-interview "澄清身份验证变更"
$ralplan "批准身份验证计划并审视取舍"
$ultragoal "将获批计划作为持久 Codex 目标执行"
```

```bash
omx --worktree=feat/task --madmax --xhigh
```

### 多会话与 worktree 示例

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

### 直接启动与 launch policy

```bash
omx --direct --yolo
```

```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

```bash
unset OMX_LAUNCH_POLICY
```

CLI policy 标志优先于环境变量；在 `--` 之前最后出现的 policy 标志生效。

```bash
OMX_LAUNCH_POLICY=direct omx --tmux --yolo
```

### Checkout 修复的持久目标

```text
# 可复制使用的持久目标示例：
/goal 修复 checkout 缺陷，并为复现、实现、回归测试和最终验证设置检查点。

$plan "批准 checkout 缺陷修复计划并审视取舍"
$ultragoal "带着检查点证据执行已批准的 checkout 修复"
```

反例：

```text
omx --madmax --xhigh
# 在说明任务前就“以防万一”加载 20 个 skill。
# 这会膨胀上下文，并让模型把注意力浪费在无关工作流上。
```

### 清理已停止的 Team

只有在确认 Team 已停止或被有意放弃后，才使用强制关闭。

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

### 额外的 Sparkshell pane 检查

```bash
omx sparkshell --tmux-pane %12 --tail-lines 400
```

## 贡献者

| 角色 | 姓名 | GitHub |
| --- | --- | --- |
| 创建者与负责人 | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| 维护者 | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| 维护者 | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## 许可证

MIT

## GEO 可见度基准

OMX 包含 [`geobench`](https://github.com/NomaDamas/geobench) 产品规范，用于衡量 LLM 命中率、MRR、声量份额和引用。

- 规范：[`geobench/oh-my-codex.yaml`](../../geobench/oh-my-codex.yaml)
- 运行手册：[`docs/geobench.md`](../../docs/geobench.md)
