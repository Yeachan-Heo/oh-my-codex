# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>先把 Codex 启动得更强，再在任务变复杂时用 OMX 的提示词、工作流和运行时能力。</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

**官网:** https://yeachan-heo.github.io/oh-my-codex-website/
**文档:** [快速开始](../getting-started.html) · [代理](../agents.html) · [技能](../skills.html) · [集成](../integrations.html) · [演示](../../DEMO.md) · [OpenClaw 指南](../openclaw-integration.zh.md)
**社区:** [Discord](https://discord.gg/PUwSMR9XNk)（oh-my-codex 与相关工具共享社区）

OMX 是 [OpenAI Codex CLI](https://github.com/openai/codex) 的工作流增强层。

<table>
<tr>
<td><strong>🚨 注意：默认推荐环境是 macOS 或 Linux + Codex CLI。</strong><br><br><strong>OMX 主要围绕这条路径持续优化。</strong><br><strong>原生 Windows 和 Codex App 不是默认体验，可能不稳定，当前支持力度也较弱。</strong></td>
</tr>
</table>

OMX 保留 Codex 作为执行引擎，并让你更容易：
- 默认启动更强的 Codex 会话
- 从澄清到完成使用一条一致工作流
- 通过 `$deep-interview`、`$ralplan`、`$team`、`$ralph` 调用标准技能
- 把项目指导、计划、日志和状态统一放在 `.omx/`

## 核心维护者

| 角色 | 名称 | GitHub |
| --- | --- | --- |
| Creator & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |

## 大使

| 名称 | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## 主要贡献者

| 名称 | GitHub |
| --- | --- |
| HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | — |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## 推荐默认流程

如果你希望获得 OMX 的默认体验，从这里开始：

```bash
npm install -g @openai/codex oh-my-codex
omx setup
omx --madmax --high
```

然后在 Codex 里正常工作：

```text
$deep-interview "clarify the authentication change"
$ralplan "approve the auth plan and review tradeoffs"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

这是主路径。
先把 OMX 以更强配置启动；在需要时先澄清；确认计划后，根据任务形态选择 `$team` 并行推进或 `$ralph` 持续收敛到完成。

## OMX 适用场景

如果你喜欢 Codex，但希望日常运行更稳定高效，OMX 适合你：
- 围绕 `$deep-interview`、`$ralplan`、`$team`、`$ralph` 的标准化工作流
- 任务需要时可调用的专用角色和辅助技能
- 通过分层 `AGENTS.md` 做项目级指导
- `.omx/` 下可持续保存的计划、日志、记忆与模式状态

如果你只想使用纯 Codex，不需要额外工作流层，通常不需要 OMX。

## 快速开始

### 环境要求

- Node.js 20+
- 已安装 Codex CLI：`npm install -g @openai/codex`
- 已完成 Codex 认证
- macOS/Linux 上建议安装 `tmux`（用于推荐的 team 运行时）
- 若你明确要走原生 Windows 次级路径，可安装 `psmux`

### 一次好的首会话

推荐启动方式：

```bash
omx --madmax --high
```

默认会直接启动交互式 leader 会话。
如果你明确希望 leader 在 tmux 内运行，使用：

```bash
omx --tmux --madmax --high
```

然后尝试标准工作流：

```text
$deep-interview "clarify the authentication change"
$ralplan "approve the safest implementation path"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

当计划需要协调并行执行时用 `$team`，当你希望单一负责人持续推进到完成时用 `$ralph`。

## 一个简单心智模型

OMX **不会**替代 Codex。

它是在 Codex 外层加一层更好用的工作层：
- **Codex** 负责实际 agent 执行
- **OMX 角色关键词** 让常用角色可复用
- **OMX 技能** 让常用流程可复用
- **`.omx/`** 保存计划、日志、记忆和运行时状态

大多数用户可以把 OMX 理解为：**更好的任务路由 + 更好的工作流 + 更好的运行时**，而不是需要整天手动操控的命令集合。

## 新用户从这里开始

1. 运行 `omx setup`
2. 用 `omx --madmax --high` 启动
3. 当需求或边界还不清楚时，使用 `$deep-interview "..."`
4. 使用 `$ralplan "..."` 审核并确认计划和权衡
5. 在协调并行时选 `$team`，在单负责人持续推进时选 `$ralph`

## 推荐工作流

1. `$deep-interview`：当范围和边界仍然模糊时，先澄清。
2. `$ralplan`：把已澄清范围收敛为可批准的架构与实现计划。
3. `$team` 或 `$ralph`：需要协同并行就用 `$team`，需要单一 owner 持续推进就用 `$ralph`。

## 会话内常用入口

| 入口 | 用途 |
| --- | --- |
| `$deep-interview "..."` | 澄清意图、边界和非目标 |
| `$ralplan "..."` | 审核实现计划与权衡 |
| `$ralph "..."` | 持续推进 + 验证闭环 |
| `$team "..."` | 当任务足够大时做协调并行 |
| `/skills` | 浏览已安装技能及辅助能力 |

## 高级 / 运维入口

这些入口有用，但不是新手主路径。

### Team runtime

当你明确需要耐久化的 tmux/worktree 协同时再使用 team runtime，而不是默认起手方式。

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

### Setup、Doctor、HUD

这些属于运维/支持入口：
- `omx setup` 会安装 prompts、skills、AGENTS 脚手架、`.codex/config.toml`，以及写入 `.codex/hooks.json` 中由 OMX 管理的原生 Codex hooks
  - setup 刷新会保留 `.codex/hooks.json` 里非 OMX 条目，只重写 OMX 管理的包装层
  - `omx uninstall` 会移除 `.codex/hooks.json` 里的 OMX 管理包装；如果用户 hooks 仍存在则保留该文件
- `omx doctor` 用于安装健康检查和故障诊断
- `omx hud --watch` 是监控/状态入口，不是主要工作流入口

对于非 team 会话，原生 Codex hooks 现在是标准生命周期入口：
- `.codex/hooks.json` = 原生 Codex hook 注册
- `.omx/hooks/*.mjs` = OMX 插件 hooks
- `omx tmux-hook` / notify-hook / derived watcher = tmux + 运行时回退路径

详见 [Codex 原生 Hook 映射](../codex-native-hooks.md)。

### Explore 与 sparkshell

- `omx explore --prompt "..."` 用于只读仓库查询
- `omx sparkshell <command>` 用于 shell 原生检查和有界验证
- 当 `.omx/wiki/` 存在时，`omx explore` 可先注入 wiki 上下文再回退到全仓搜索

示例：

```bash
omx explore --prompt "find where team state is written"
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Wiki

- `omx wiki` 是 OMX wiki MCP 服务的 CLI 对等入口
- wiki 数据本地存放在 `.omx/wiki/`
- wiki 是 markdown-first、search-first，而不是 vector-first

示例：

```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Team 模式平台说明

`omx team` 在 macOS/Linux + `tmux` 下体验最佳。
原生 Windows 是次级路径；如果你是 Windows 主机，通常 WSL2 更推荐。

| 平台 | 安装命令 |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## 已知问题

### Intel Mac：启动时 `syspolicyd` / `trustd` CPU 偏高

在部分 Intel Mac 上，OMX 启动（尤其 `--madmax --high`）期间，macOS Gatekeeper 对并发进程做校验时可能导致 `syspolicyd` / `trustd` CPU 峰值。

如果遇到这个问题，可以尝试：
- `xattr -dr com.apple.quarantine $(which omx)`
- 在 macOS 安全设置里把你的终端加入 Developer Tools 允许列表
- 降低并发（例如避免 `--madmax --high`）

## 文档

- [快速开始](../getting-started.html)
- [Demo 指南](../../DEMO.md)
- [Wiki 功能](../wiki-feature.md)
- [代理目录](../agents.html)
- [技能参考](../skills.html)
- [Codex 原生 Hook 映射](../codex-native-hooks.md)
- [集成](../integrations.html)
- [OpenClaw / 通知网关指南](../openclaw-integration.zh.md)
- [贡献指南](../../CONTRIBUTING.md)
- [更新日志](../../CHANGELOG.md)

## 语言

- [English](../../README.md)
- [한국어](./README.ko.md)
- [日本語](./README.ja.md)
- [简体中文](./README.zh.md)
- [繁體中文](./README.zh-TW.md)
- [Tiếng Việt](./README.vi.md)
- [Español](./README.es.md)
- [Português](./README.pt.md)
- [Русский](./README.ru.md)
- [Türkçe](./README.tr.md)
- [Deutsch](./README.de.md)
- [Français](./README.fr.md)
- [Italiano](./README.it.md)
- [Ελληνικά](./README.el.md)
- [Polski](./README.pl.md)
- [Українська](./README.uk.md)

## 贡献者

| 角色 | 名称 | GitHub |
| --- | --- | --- |
| Creator & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## 许可证

MIT
