# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Start Codex stronger, then let OMX add better prompts, workflows, and runtime help when the work grows.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

**Website:** https://yeachan-heo.github.io/oh-my-codex-website/  
**Docs:** [Getting Started](./docs/getting-started.html) · [Agents](./docs/agents.html) · [Skills](./docs/skills.html) · [Integrations](./docs/integrations.html) · [Demo](./DEMO.md) · [OpenClaw guide](./docs/openclaw-integration.md)

OMX is a workflow layer for [OpenAI Codex CLI](https://github.com/openai/codex).

It keeps Codex as the execution engine and makes it easier to:
- start a stronger Codex session by default
- reuse good role/task invocations with `$name` keywords
- invoke workflows with skills like `$plan`, `$ralph`, and `$team`
- keep project guidance, plans, logs, and state in `.omx/`

## Recommended default flow

If you want the default OMX experience, start here:

```bash
npm install -g @openai/codex oh-my-codex
omx setup
omx --madmax --high
```

Then work normally inside Codex:

```text
$architect "analyze the authentication flow"
$plan "ship this feature cleanly"
```

That is the main path.
Start OMX strongly, do the work in Codex, and let the agent pull in `$team` or other workflows only when the task actually needs them.

## What OMX is for

Use OMX if you already like Codex and want a better day-to-day runtime around it:
- reusable role/task invocations such as `$architect` and `$executor`
- reusable workflows such as `$plan`, `$ralph`, `$team`, and `$deep-interview`
- project guidance through scoped `AGENTS.md`
- durable state under `.omx/` for plans, logs, memory, and mode tracking

If you want plain Codex with no extra workflow layer, you probably do not need OMX.

## Quick start

### Requirements

- Node.js 20+
- Codex CLI installed: `npm install -g @openai/codex`
- Codex auth configured
- `tmux` on macOS/Linux if you later want the durable team runtime
- `psmux` on native Windows if you later want Windows team mode

### A good first session

Launch OMX the recommended way:

```bash
omx --madmax --high
```

Then try one role keyword and one workflow skill:

```text
$architect "analyze the authentication flow"
$plan "map the safest implementation path"
```

If the task grows, the agent can escalate to heavier workflows such as `$ralph` for persistent execution or `$team` for coordinated parallel work.

## A simple mental model

OMX does **not** replace Codex.

It adds a better working layer around it:
- **Codex** does the actual agent work
- **OMX role keywords** make useful roles reusable
- **OMX skills** make common workflows reusable
- **`.omx/`** stores plans, logs, memory, and runtime state

Most users should think of OMX as **better task routing + better workflow + better runtime**, not as a command surface to operate manually all day.

## Start here if you are new

1. Run `omx setup`
2. Launch with `omx --madmax --high`
3. Ask for analysis with `$architect "..."`
4. Ask for planning with `$plan "..."`
5. Let the agent decide when `$ralph`, `$team`, or another workflow is worth using

## Common in-session surfaces

| Surface | Use it for |
| --- | --- |
| `$architect "..."` | analysis, boundaries, tradeoffs |
| `$executor "..."` | focused implementation work |
| `/skills` | browsing installed skills |
| `$plan "..."` | planning before implementation |
| `$ralph "..."` | persistent sequential execution |
| `$team "..."` | coordinated parallel execution when the task is big enough |

Use `$deep-interview` when the request is still vague, the boundaries are unclear, or you want OMX to keep pressing on intent, non-goals, and decision boundaries before it hands work off to `$plan`, `$ralph`, `$team`, or `$autopilot`.

Typical cases:
- vague greenfield ideas that still need sharper intent and scope
- brownfield changes where OMX should inspect the repo first, then ask cited confirmation questions
- requests where you want a one-question-at-a-time clarification loop instead of immediate planning or implementation
## Advanced / operator surfaces

These are useful, but they are not the main onboarding path.

### Team runtime

Use the team runtime when you specifically need durable tmux/worktree coordination, not as the default way to begin using OMX.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

### Setup, doctor, and HUD

These are operator/support surfaces:
- `omx setup` installs prompts, skills, config, and AGENTS scaffolding
- `omx doctor` verifies the install when something seems wrong
- `omx hud --watch` is a monitoring/status surface, not the primary user workflow

### Explore and sparkshell

- `omx explore --prompt "..."` is for read-only repository lookup
- `omx sparkshell <command>` is for shell-native inspection and bounded verification

Examples:

```bash
omx explore --prompt "find where team state is written"
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Platform notes for team mode

`omx team` needs a tmux-compatible backend:

| Platform | Install |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Known issues

### Intel Mac: high `syspolicyd` / `trustd` CPU during startup

On some Intel Macs, OMX startup — especially with `--madmax --high` — can spike `syspolicyd` / `trustd` CPU usage while macOS Gatekeeper validates many concurrent process launches.

If this happens, try:
- `xattr -dr com.apple.quarantine $(which omx)`
- adding your terminal app to the Developer Tools allowlist in macOS Security settings
- using lower concurrency (for example, avoid `--madmax --high`)

## Documentation

- [Getting Started](./docs/getting-started.html)
- [Demo guide](./DEMO.md)
- [Agent catalog](./docs/agents.html)
- [Skills reference](./docs/skills.html)
- [Integrations](./docs/integrations.html)
- [OpenClaw / notification gateway guide](./docs/openclaw-integration.md)
- [Contributing](./CONTRIBUTING.md)
- [Changelog](./CHANGELOG.md)

## Languages

- [English](./README.md)
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

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## License

MIT
