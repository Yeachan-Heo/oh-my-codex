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

**Community:** [Discord](https://discord.gg/PUwSMR9XNk) — shared OMX/community server for oh-my-codex and related tooling.

OMX is a workflow layer for [OpenAI Codex CLI](https://github.com/openai/codex).

<table>
<tr>
<td><strong>🚨 CAUTION — RECOMMENDED DEFAULT ONLY: macOS or Linux with Codex CLI.</strong><br><br><strong>OMX is primarily designed and actively tuned for that path.</strong><br><strong>Native Windows and Codex App are not the default experience, may break or behave inconsistently, and currently receive less support.</strong></td>
</tr>
</table>

It keeps Codex as the execution engine and makes it easier to:
- start a stronger Codex session by default
- run one consistent workflow from clarification to completion
- invoke the canonical skills with `$deep-interview`, `$ralplan`, `$team`, and `$ralph`
- keep project guidance, plans, logs, and state in `.omx/`

## Core Maintainers

| Role | Name | GitHub |
| --- | --- | --- |
| Creator & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |

## Ambassadors

| Name | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Top Collaborators

| Name | GitHub |
| --- | --- |
| HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | — |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Recommended default flow

If you want the default OMX experience, start here:

```bash
npm install -g @openai/codex oh-my-codex
omx --madmax --high
```

On a real `oh-my-codex` version bump, the global npm install now prints an explicit reminder instead of launching `omx setup` automatically. When you're ready, run `omx setup` manually or use `omx update` to check npm and then run the same setup refresh path.

**Codex plugin install note:** this repo also ships an official Codex plugin layout at `plugins/oh-my-codex` with marketplace metadata in `.agents/plugins/marketplace.json`. That plugin now bundles the mirrored skill surface plus plugin-scoped companion metadata for MCP servers and apps. Native/runtime hooks still stay on the setup/runtime side rather than the installable plugin manifest. It is still **not** a replacement for `npm install -g oh-my-codex` plus `omx setup`: `omx setup` remains responsible for native agents, prompts/config/hooks/AGENTS.md/HUD/runtime wiring, including native `.codex/hooks.json` coverage.

Then work normally inside Codex:

```text
$deep-interview "clarify the authentication change"
$ralplan "approve the auth plan and review tradeoffs"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

That is the main path.
Before you treat the runtime as ready, run the quick-start smoke test below: `omx doctor` verifies the install shape, while `omx exec` proves the active Codex runtime can actually authenticate and complete a model call from the current environment.
Start OMX strongly, clarify first when needed, approve the plan, then choose `$team` for coordinated parallel execution or `$ralph` for the persistent completion loop.

## What OMX is for

Use OMX if you already like Codex and want a better day-to-day runtime around it:
- a standard workflow built around `$deep-interview`, `$ralplan`, `$team`, and `$ralph`
- specialist roles and supporting skills when the task needs them
- project guidance through scoped `AGENTS.md`
- durable state under `.omx/` for plans, logs, memory, and mode tracking

If you want plain Codex with no extra workflow layer, you probably do not need OMX.

## Quick start

### Requirements

- Node.js 20+
- Codex CLI installed: `npm install -g @openai/codex`
- Codex auth configured and visible in the same shell/profile that will run OMX
- `tmux` on macOS/Linux if you want the recommended durable team runtime
- `psmux` on native Windows only if you intentionally want the less-supported Windows team path

### A good first session

After install, check both boundaries:

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` catches missing OMX files, hooks, and runtime prerequisites. The real smoke test catches auth, profile, and provider/base-URL problems that only appear when Codex performs an actual request.

Launch OMX the recommended way:

```bash
omx --madmax --high
```

This starts the interactive leader session directly by default.
If you explicitly want the leader session in tmux, use:

```bash
omx --tmux --madmax --high
```

Then try the canonical workflow:

```text
$deep-interview "clarify the authentication change"
$ralplan "approve the safest implementation path"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

Use `$team` when the approved plan needs coordinated parallel work, or `$ralph` when one persistent owner should keep pushing to completion.

## A simple mental model

OMX does **not** replace Codex.

It adds a better working layer around it:
- **Codex** does the actual agent work
- **OMX role keywords** make useful roles reusable
- **OMX skills** make common workflows reusable
- **`.omx/`** stores plans, logs, memory, and runtime state

Most users should think of OMX as **better task routing + better workflow + better runtime**, not as a command surface to operate manually all day.

## Start here if you are new

1. Install or update OMX with `npm install -g @openai/codex oh-my-codex`
2. After install or real OMX version bumps, run `omx setup` yourself when you're ready, or use `omx update` when you also want npm to check for and install the latest build before refreshing setup
3. Run `omx doctor`
4. Run a real execution smoke test: `codex login status` and `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`
5. Launch with `omx --madmax --high`
6. Use `$deep-interview "..."` when the request or boundaries are still unclear
7. Use `$ralplan "..."` to approve the plan and review tradeoffs
8. Choose `$team` for coordinated parallel execution or `$ralph` for persistent completion loops

## Recommended workflow

1. `$deep-interview` — clarify scope when the request or boundaries are still vague.
2. `$ralplan` — turn that clarified scope into an approved architecture and implementation plan.
3. `$team` or `$ralph` — use `$team` for coordinated parallel execution, or `$ralph` when you want a persistent completion loop with one owner.

## Common in-session surfaces

| Surface | Use it for |
| --- | --- |
| `$deep-interview "..."` | clarifying intent, boundaries, and non-goals |
| `$ralplan "..."` | approving the implementation plan and tradeoffs |
| `$ralph "..."` | persistent completion and verification loops |
| `$team "..."` | coordinated parallel execution when the work is big enough |
| `/skills` | browsing installed skills and supporting helpers |

## Advanced / operator surfaces

These are useful, but they are not the main onboarding path.

### Team runtime

Use the team runtime when you specifically need durable tmux/worktree coordination, not as the default way to begin using OMX. In Codex App or plain outside-tmux sessions, treat `omx team` as a tmux-runtime shell surface rather than a directly available in-app workflow; launch OMX CLI from shell first if you actually want team execution.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

### Setup, doctor, and HUD

These are operator/support surfaces:
- Codex plugin marketplace install/discovery can cache the plugin under `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/` (local installs may use `local` as the version identifier); that packaged plugin now includes plugin-scoped companion metadata for MCP servers and apps, while native/runtime hooks remain setup-owned, so it is still not the full OMX runtime setup
- `omx setup` installs prompts, skills, AGENTS scaffolding, `.codex/config.toml`, and OMX-managed native Codex hooks in `.codex/hooks.json`
  - setup refresh preserves non-OMX hook entries in `.codex/hooks.json` and only rewrites OMX-managed wrappers
  - `omx uninstall` removes OMX-managed wrappers from `.codex/hooks.json` but keeps the file when user hooks remain
- `omx update` checks npm immediately, installs the newest global OMX build, then reruns the same interactive setup refresh path
- fresh OMX-managed `gpt-5.5` config seeding now recommends `model_context_window = 250000` and `model_auto_compact_token_limit = 200000`, but only when those keys are missing
- `omx doctor` verifies the install when something seems wrong; it does not prove that the active Codex profile can make an authenticated model call
- `omx hud --watch` is a monitoring/status surface, not the primary user workflow

For non-team sessions, native Codex hooks are now the canonical lifecycle surface:
- `.codex/hooks.json` = native Codex hook registrations
- `.omx/hooks/*.mjs` = OMX plugin hooks
- `omx tmux-hook` / notify-hook / derived watcher = tmux + runtime fallback paths

See [Codex native hook mapping](./docs/codex-native-hooks.md) for the current native / fallback matrix.


### Troubleshooting false-green readiness

A green `omx doctor` means the install and local runtime wiring look sane. If real execution still fails, check the environment Codex actually uses:

- Run `codex login status` and `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"` from the same shell/profile that will launch OMX.
- In custom HOME, profile, container, or service shells, confirm the active `~/.codex` (or `CODEX_HOME`) is the one with the expected auth and config. Do not assume your normal user `~/.codex` is visible there.
- If you depend on a local OpenAI-compatible proxy, confirm the active `~/.codex/config.toml` includes the expected `openai_base_url`; otherwise a proxy-issued key can be sent to the default endpoint and fail with `401 Unauthorized`, `Missing bearer or basic authentication in header`, or `Incorrect API key provided`.
- If `omx doctor --team` or resume reports a stale team such as `resume_blocker` or a missing tmux session, clean the dead runtime state before retrying:

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

Only use the forced team shutdown for a team you have confirmed is dead or intentionally abandoned.

If `Shift+Enter` still submits instead of inserting a newline inside an OMX-managed tmux session, see [Troubleshooting execution readiness](./docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions). Current OMX already enables tmux extended-key forwarding around its own Codex launch paths, so a persistent failure is usually a tmux terminal-capability/discoverability problem rather than a net-new OMX feature gap.

### Explore and sparkshell

- `omx explore --prompt "..."` is for read-only repository lookup
- `omx sparkshell <command>` is for shell-native inspection and bounded verification
- when `.omx/wiki/` exists, `omx explore` can inject wiki-first context before falling back to broader repository search

Examples:

```bash
omx explore --prompt "find where team state is written"
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Wiki

- `omx wiki` is the CLI parity surface for the OMX wiki MCP server
- wiki data lives locally under `.omx/wiki/`
- the wiki is markdown-first and search-first, not vector-first

Examples:

```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Platform notes for team mode

`omx team` works best on macOS/Linux with `tmux`.
Native Windows remains a secondary path, and WSL2 is generally the better choice if you want a Windows-hosted setup.
On native Windows, OMX accepts `psmux` as the tmux-compatible binary for the existing tmux-backed paths it already uses.

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
- [Wiki feature](./docs/wiki-feature.md)
- [Agent catalog](./docs/agents.html)
- [Skills reference](./docs/skills.html)
- [Codex native hook mapping](./docs/codex-native-hooks.md)
- [Integrations](./docs/integrations.html)
- [Troubleshooting execution readiness](./docs/troubleshooting.md)
- [OpenClaw / notification gateway guide](./docs/openclaw-integration.md)
- [Contributing](./CONTRIBUTING.md)
- [Changelog](./CHANGELOG.md)

## Languages

- [English](./README.md)
- [한국어](./docs/readme/README.ko.md)
- [日本語](./docs/readme/README.ja.md)
- [简体中文](./docs/readme/README.zh.md)
- [繁體中文](./docs/readme/README.zh-TW.md)
- [Tiếng Việt](./docs/readme/README.vi.md)
- [Español](./docs/readme/README.es.md)
- [Português](./docs/readme/README.pt.md)
- [Русский](./docs/readme/README.ru.md)
- [Türkçe](./docs/readme/README.tr.md)
- [Deutsch](./docs/readme/README.de.md)
- [Français](./docs/readme/README.fr.md)
- [Italiano](./docs/readme/README.it.md)
- [Ελληνικά](./docs/readme/README.el.md)
- [Polski](./docs/readme/README.pl.md)
- [Українська](./docs/readme/README.uk.md)

## Contributors

| Role | Name | GitHub |
| --- | --- | --- |
| Creator & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## License

MIT
