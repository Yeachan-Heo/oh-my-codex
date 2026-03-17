# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Your codex is not alone.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1466022107199574193?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/qRJw62Gvh7)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[OpenClaw Integration Guide](./docs/openclaw-integration.md)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)** | **[Discord](https://discord.gg/qRJw62Gvh7)**

Operational runtime for [OpenAI Codex CLI](https://github.com/openai/codex).

## Featured Guides

- [OpenClaw / Generic Notification Gateway Integration Guide](./docs/openclaw-integration.md)
- [Spark Initiative hotfix release notes (v0.9.1)](./docs/release-notes-0.9.1.md)
- [Spark Initiative hotfix release body (v0.9.1)](./docs/release-body-0.9.1.md)

## Languages

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

OMX turns Codex into an operational runtime for real multi-step work:
- **Team Mode first** — coordinated multi-agent execution with shared visibility, resume, recovery, and lifecycle control
- **Role prompts + skills** — productized behaviors for planners, executors, reviewers, and reusable workflows
- **Persistent runtime state** — MCP-backed state, memory, mailbox, plans, and diagnostics in `.omx/`
- **Operator controls** — launch, inspect, verify, cancel, and resume long-running work without replacing Codex itself

## Why OMX

Codex CLI is unusually well suited to persistent orchestration: it is lightweight enough to stay alive across long sessions, tmux lanes, and repeated handoffs without burying coordination under a heavy shell stack.

That matters because orchestration is not just fanout. It needs durable state, shared situational awareness, visible recovery paths, and tight operator control. Heavier shell-centric wrappers can be fine for one-shot launches, but they are a poor fit for always-on coordination where every extra layer adds latency, noise, and failure surface.

OMX keeps Codex as the execution engine and adds the runtime around it.

## Runtime model

OMX is a small operational runtime layered around Codex:
- **Execution plane:** Codex runs the actual agent work
- **Control plane:** `omx` manages team workers, lifecycle commands, HUD/tmux integration, and recovery
- **State plane:** MCP servers back state, mailbox, memory, diagnostics, and project context

This keeps the stack simple: Codex stays in the loop, while OMX makes the work inspectable, resumable, and repeatable.

## Team Mode vs. Ultrawork

If you are deciding between the two, start with **Team Mode**.

- **`$team` / `omx team`** — default for substantial work. Use it when tasks share context, blockers matter, handoffs are likely, or you want durable runtime control.
- **`$ultrawork`** — use it for lightweight parallel fanout when subtasks are mostly independent and the leader can merge results afterward.

In short: **Ultrawork is parallelism. Team Mode is orchestration.**

Low-token Team Mode profile example:

```bash
OMX_TEAM_WORKER_CLI=codex \
OMX_TEAM_WORKER_LAUNCH_ARGS='-c model_reasoning_effort="low"' \
omx team 2:explore "short scoped analysis task"
```

## Requirements

- Node.js >= 20 (CI validates Node 20 and current LTS, currently Node 22)
- Codex CLI installed (`npm install -g @openai/codex`)
- Codex auth configured

### Platform & tmux

OMX features like `omx team` require **tmux**:

| Platform       | tmux provider                                            | Install                |
| -------------- | -------------------------------------------------------- | ---------------------- |
| macOS          | [tmux](https://github.com/tmux/tmux)                    | `brew install tmux`    |
| Ubuntu/Debian  | tmux                                                     | `sudo apt install tmux`|
| Fedora         | tmux                                                     | `sudo dnf install tmux`|
| Arch           | tmux                                                     | `sudo pacman -S tmux`  |
| Windows        | [psmux](https://github.com/marlocarlo/psmux) (native)   | `winget install psmux` |
| Windows (WSL2) | tmux (inside WSL)                                        | `sudo apt install tmux`|

> **Windows users:** [psmux](https://github.com/marlocarlo/psmux) provides a native `tmux` binary for Windows with 76 tmux-compatible commands. No WSL required.

## Quickstart (3 minutes)

```bash
npm install -g @openai/codex oh-my-codex
omx setup
omx doctor --team
omx team 3:executor "ship the scoped task with verification"
```

## Model defaults and local-model overrides

OMX treats default model selection as a small explicit contract:

- `OMX_DEFAULT_FRONTIER_MODEL` — canonical frontier/default leader model
- `OMX_DEFAULT_SPARK_MODEL` — canonical spark / low-complexity worker model

If upstream defaults change, update the single canonical source instead of scattering model literals across prompts/docs/runtime.

For local-model setups, you can persist overrides in `~/.codex/.omx-config.json` (or `CODEX_HOME/.omx-config.json`) under the top-level `env` field:

```json
{
  "env": {
    "OMX_DEFAULT_FRONTIER_MODEL": "your-frontier-model",
    "OMX_DEFAULT_SPARK_MODEL": "your-spark-model"
  }
}
```

Resolution order:

1. Real shell env vars
2. `.omx-config.json` `env` overrides
3. OMX built-in canonical defaults

The same config-driven env overrides are forwarded when OMX launches native helpers such as `omx sparkshell`, so local-model routing stays consistent.

Recommended trusted-environment launch profile:

```bash
omx --xhigh --madmax
```

## New in v0.9.0 — Spark Initiative

<p align="center">
  <img src="./docs/shared/omx-character-spark-initiative.jpg" alt="OMX character sparked for the Spark Initiative" width="720">
</p>

`0.9.0` is the **Spark Initiative** release: OMX now ships a stronger native fast path for read-only repository discovery, shell-native inspection, and cross-platform native distribution.

`0.9.1` is the clean superseding hotfix release for the Spark Initiative line: it carries the packed-install smoke hydration fix that was merged into `dev` after `v0.9.0`, while `v0.9.0` remains historically red.

- **`omx explore` native harness** — qualifying read-only exploration runs through a constrained native Rust helper with explicit allowlists and fallback behavior.
- **`omx sparkshell`** — a first-class operator surface for fast shell-native inspection, adaptive summaries, and explicit tmux-pane capture.
- **Cross-platform native release assets** — tagged releases now publish native archives for both `omx-explore-harness` and `omx-sparkshell`, plus `native-release-manifest.json` for hydration and checksum verification.
- **Release-oriented verification lanes** — `npm run build:full`, `npm run test:explore`, `npm run test:sparkshell`, and packed-install smoke verification now cover the new native surfaces.
- **Sharper install/runtime fallback order** — OMX prefers explicit `OMX_*_BIN` overrides, then hydrated per-user native cache, then repo-local development artifacts.

Spark Initiative references:

- [Release notes: `v0.9.1`](./docs/release-notes-0.9.1.md)
- [Release body: `v0.9.1`](./docs/release-body-0.9.1.md)
- [Release readiness draft: `v0.9.1`](./docs/qa/release-readiness-0.9.1.md)

Quick Spark Initiative smoke path:

```bash
npm run build:full
omx explore --prompt "git log --oneline -10"
omx sparkshell git --version
omx sparkshell --tmux-pane %12 --tail-lines 400
```

## First Session

Inside Codex:

```text
$plan "ship OAuth callback safely"
$team 3:executor "implement safely with shared verification"
/prompts:architect "review the boundary decisions"
/prompts:executor "take the next scoped task"
```

From terminal:

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team status <team-name> --json
omx team status <team-name> --tail-lines 600
omx team resume <team-name>
omx team shutdown <team-name>
```

## Core Model

OMX installs and wires these layers:

```text
User / Operator
  -> OMX runtime
    -> Codex CLI (execution engine)
    -> AGENTS.md (orchestration brain)
    -> ~/.codex/prompts/*.md (installable active/internal agent prompt catalog)
    -> ~/.codex/skills/*/SKILL.md (skill catalog)
    -> ~/.codex/config.toml (features, notify, MCP)
    -> .omx/ (runtime state, memory, plans, logs)
```

## Experimental: posture-aware routing

This branch includes an experimental routing layer that separates:

- `role`: agent responsibility (`executor`, `planner`, `architect`)
- `tier`: reasoning depth / cost (`LOW`, `STANDARD`, `THOROUGH`)
- `posture`: operating style (`frontier-orchestrator`, `deep-worker`, `fast-lane`)

Current intent of the experiment:

- **Frontier-orchestrator**: leader/router posture for steerable frontier models
- **Deep-worker**: implementation-first posture for executor-style roles
- **Fast-lane**: lightweight triage/search posture for fast models

This is designed to make OMX's initial routing behavior more Sisyphus-like without removing the existing Hephaestus-like execution lane.

### How to test this experiment

1. Build the project (TypeScript + native Rust helpers):

```bash
npm run build:full
```

If you only need the TypeScript output, `npm run build` still runs just `tsc`.

2. Reinstall native agent configs:

```bash
node bin/omx.js setup
```

3. Inspect generated native agent configs in `~/.omx/agents/` and confirm they now include:
   - `## OMX Posture Overlay`
   - `## Model-Class Guidance`
   - `## OMX Agent Metadata`

4. Spot-check representative roles:
   - `planner` / `architect` / `critic` -> `frontier-orchestrator`
   - `executor` / `build-fixer` / `test-engineer` -> `deep-worker`
   - `explore` / `writer` -> `fast-lane`

5. Run focused tests:

```bash
node --test dist/agents/__tests__/definitions.test.js dist/agents/__tests__/native-config.test.js
```

This experiment currently changes native prompt generation and metadata, not the full prose of every prompt file.

## Main Commands

```bash
omx                # Launch Codex inside the OMX runtime (+ HUD in tmux when available)
omx team ...       # Start/status/resume/shutdown coordinated team workers (default orchestration surface)
omx setup          # Install prompts/skills/config by scope + project .omx + scope-specific AGENTS.md
omx agents-init .  # Bootstrap lightweight AGENTS.md files for a repo/subtree
omx doctor         # Installation/runtime diagnostics
omx doctor --team  # Team Mode diagnostics
omx ask ...        # Ask local provider advisor (claude|gemini), writes .omx/artifacts/*
omx resume         # Resume a previous interactive Codex session
omx explore ...    # Default read-only exploration entrypoint (may use sparkshell backend)
omx ralph          # Launch Codex with ralph persistence mode active
omx autoresearch <mission-dir> # Launch thin-supervisor autoresearch with keep/discard/reset parity
omx status         # Show active modes
omx cancel         # Cancel active execution modes
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (plugin extension workflow)
omx hud ...        # --watch|--json|--preset
omx version        # Show version information
omx help           # Show help message
```

Ask command examples:

```bash
omx ask claude "review this diff"
omx ask gemini "brainstorm alternatives"
omx ask claude --agent-prompt executor "implement feature X with tests"
omx ask gemini --agent-prompt=planner --prompt "draft a rollout plan"
# underlying provider flags from CLI help:
# claude -p|--print "<prompt>"
# gemini -p|--prompt "<prompt>"
```

Explore command examples:

```bash
omx explore --prompt "which files define team routing"
omx explore --prompt-file prompts/explore-task.md
USE_OMX_EXPLORE_CMD=1 omx   # advisory preference for simple read-only exploration prompts
```

Autoresearch command example:

```bash
mkdir -p missions/demo
cat > missions/demo/mission.md <<'EOF'
# Mission
Solve the scoped task in this repository.
EOF
cat > missions/demo/sandbox.md <<'EOF'
---
evaluator:
  command: node scripts/eval.js
  format: json
---
Stay inside the mission boundary and stop when the evaluator passes.
EOF
omx autoresearch missions/demo
```

`omx autoresearch` now runs as a thin supervisor around one Codex experiment session at a time. A fresh launch creates a run-tagged `autoresearch/<slug>/<run-tag>` worktree lane, seeds the baseline evaluator row, writes authoritative per-run artifacts under `.omx/logs/autoresearch/<run-id>/`, and expects the session to hand back a repo-root `candidate.json` artifact. Each iteration's bootstrap instructions include the current baseline/last-kept state plus a bounded recent ledger summary, and `status=candidate` artifacts must point at the current worktree `HEAD` and last-kept base commit. After each session exit, OMX evaluates the candidate, records keep/discard/reset state, hard-resets discarded or ambiguous experiments back to the last kept commit, and relaunches the next iteration unless the run aborts. Use `omx autoresearch --resume <run-id>` to continue an existing run from its manifest/worktree.

Autoresearch showcase:

For the canonical autoresearch showcase — including completed research-style demos, missions, evaluators, and the lightweight runner script — see [`playground/README.md`](playground/README.md).

`omx explore` is the default OMX surface for simple read-only exploration. It stays intentionally read-only and shell-only, and qualifying shell-native read-only tasks may be routed through `omx sparkshell` as a backend when that is the cheaper/more direct fit. The routing flag only adds advisory steering in generated session instructions; ambiguous or implementation-heavy requests stay on the normal Codex path, and OMX falls back normally if the explore harness is unavailable. The harness constrains Codex through a temporary allowlisted shell/bin layer so only approved repository-inspection command families are available during the offloaded run.

- Current shell allowlist: `rg`, `grep`, `ls`, `find`, `wc`, `cat`, `head`, `tail`, `pwd`, `printf`
- Current shell restrictions: no pipes, redirection, `&&`, `||`, `;`, subshells, path-qualified binaries, non-allowlisted commands, stdin-fed inspection, or path escapes outside the target repository (including existing symlink-resolved escapes)
- `omx explore` is **not** a full parity surface for modern Codex read-only mode: it does not promise web search, MCP, images, or general-purpose tool access


Packaging / install notes:

- Published npm packages now include the Rust workspace files for the explore harness (`Cargo.toml`, `Cargo.lock`, `crates/`).
- npm publishes no longer rely on publisher-platform native binaries.
- Tagged releases build multi-platform native archives for both `omx-explore-harness` and `omx-sparkshell` via cargo-dist and attach them to the GitHub Release from `.github/workflows/release.yml`.
- Runtime now prefers `OMX_*_BIN` overrides, then a hydrated per-user native cache, then repo-local development artifacts.
- `omx explore` keeps a source-install `cargo run --manifest-path crates/omx-explore/Cargo.toml -- ...` fallback in repository checkouts; packaged installs rely on release-asset hydration unless `OMX_EXPLORE_BIN` is set.
- `omx sparkshell` hydrates from release assets when no override or repo-local build output is available.
- Release assets now include `native-release-manifest.json` with per-target download metadata and SHA-256 checksums.
- Helpful local commands:

```bash
npm run build:full
npm run build:explore
npm run build:explore:release
npm run test:explore
node scripts/smoke-packed-install.mjs --release-assets-dir ./release-assets
node scripts/check-version-sync.mjs --tag v$(node -p "require('./package.json').version")
```

`npm run build:full` is the one-shot source build for TypeScript plus the packaged explore harness and sparkshell native binary.

Non-tmux team launch (advanced):

```bash
OMX_TEAM_WORKER_LAUNCH_MODE=prompt omx team 2:executor "task"
```

## Hooks Extension (Additive Surface)

OMX now includes `omx hooks` for plugin scaffolding and validation.

- `omx tmux-hook` remains supported and unchanged.
- `omx hooks` is additive and does not replace tmux-hook workflows.
- Plugin files live at `.omx/hooks/*.mjs`.
- Plugins are off by default; enable with `OMX_HOOK_PLUGINS=1`.

See `docs/hooks-extension.md` for the full extension workflow and event model.

## Sparkshell (Spark Initiative surface)

`omx sparkshell <command> [args...]` runs through a JS -> Rust sidecar bridge for fast command execution with adaptive summaries when output exceeds `OMX_SPARKSHELL_LINES`. In `0.9.0`, it became a first-class Spark Initiative surface: `omx explore` can use it as a backend for qualifying read-only shell-native tasks, while `omx sparkshell` remains the explicit operator-facing command for direct use.

It remains an explicit operator-facing command, but OMX may also use it as a backend for qualifying `omx explore` read-only shell-native tasks. That backend relationship does not relax read-only safety: non-read-only or unsupported shell execution should still stay blocked or on the normal path.

Current preview contract:
- Short output stays raw; long output is summarized into markdown sections limited to `summary:`, `failures:`, and `warnings:`.
- Summary mode uses the local Codex CLI via `codex exec` and prefers `OMX_SPARKSHELL_MODEL`, then `OMX_DEFAULT_SPARK_MODEL`, then the spark default model.
- `--spark` / `--madmax-spark` remain team-worker launch flags; sparkshell model routing is controlled by env vars instead.
- Native binary lookup order is `OMX_SPARKSHELL_BIN`, then the hydrated native cache, then packaged dev artifacts (when present), then repo-local workspace output `target/release/omx-sparkshell[.exe]`.
- Team/leader pane summarization is explicit opt-in via tmux pane mode, for example:

```bash
omx sparkshell --tmux-pane %12 --tail-lines 400
```

- tmux pane mode captures a larger pane tail (100-1000 lines) and applies the same raw-vs-summary behavior to worker/leader pane context.
- sparkshell pane summarization is not always-on; it is enabled only when explicitly requested.

Preview build helpers:

```bash
npm run build:sparkshell
npm run test:sparkshell
```

For a full local source build in one command, use `npm run build:full`.

## Launch Flags

```bash
--yolo              # Launch Codex in yolo mode
--high              # High reasoning effort (shorthand for -c model_reasoning_effort="high")
--xhigh             # xhigh reasoning effort (shorthand for -c model_reasoning_effort="xhigh")
--madmax            # DANGEROUS: bypass Codex approvals and sandbox
--spark             # Use Codex spark model for team workers only (~1.3x faster)
--madmax-spark      # spark model for workers + bypass approvals for leader and workers
-w, --worktree[=<name>]  # Launch Codex in a git worktree (detached when no name given)
--force             # Enable destructive maintenance (for example stale/deprecated skill cleanup)
--dry-run           # Show what would be done without doing it
--keep-config       # Skip config.toml cleanup during uninstall
--purge             # Remove .omx/ cache directory during uninstall
--verbose           # Show detailed output
--scope <user|project>  # setup only
```

`--madmax` maps to Codex `--dangerously-bypass-approvals-and-sandbox`.
Use it only in trusted/external sandbox environments.

### MCP workingDirectory policy (optional hardening)

By default, MCP state/memory/trace tools accept caller-provided `workingDirectory`.
To constrain this, set an allowlist of roots:

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

When set, `workingDirectory` values outside these roots are rejected.

## Codex-First Prompt Control

By default, OMX injects:

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

This merges `CODEX_HOME/AGENTS.md` with project `./AGENTS.md` guidance (when present), then appends the runtime overlay.
It extends Codex behavior, but does not replace/bypass Codex core system policies.

Controls:

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # disable AGENTS.md injection
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## Team Mode

Use team mode for broad work that benefits from parallel workers.

Lifecycle:

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

Operational commands:

```bash
omx team <args>
omx team --help
omx team api --help
omx team status <team-name>
omx team status <team-name> --json
omx team status <team-name> --tail-lines 600
omx team resume <team-name>
omx team shutdown <team-name>
```

```bash
omx resume --last
```

Important rule: do not shutdown while tasks are still `in_progress` unless aborting.

### Recommended high-control workflow: `ralplan -> team -> ralph`

For contributors who want tighter control than `autopilot` but more coordination than `$ultrawork`, the strongest workflow is:

```text
ralplan -> team -> ralph
```

Why this combination works well:
- **`ralplan`** turns a rough request into a spec, acceptance checks, and a lane-ready breakdown before workers start.
- **`$team`** executes that plan with durable worker coordination, visible runtime state, and better handling of blockers than simple fanout.
- **`$ralph`** keeps the loop alive until verification is real, evidence is fresh, and cleanup is explicit.

In practice, this is the right workflow when you want to stay in control of planning and orchestration while still getting parallel execution. `autopilot` can chain these modes for you, but advanced users will often prefer running the sequence directly so they can tune worker roles, follow-up stages, and verification thresholds themselves.

Example:

```bash
omx ask --agent-prompt planner "ralplan: break this feature into worker lanes and acceptance checks"
omx team 3:executor "execute the approved ralplan with shared runtime coordination"
```

Planned documentation/product direction: make `ralplan` produce stronger team follow-up guidance by default, including worker placement hints and an explicit follow-up path such as `--followup team`.

### Why `omx team ralph` is a linked launch path

Use `omx team ralph ...` when the team run and Ralph follow-up should behave as
one linked lifecycle, not as two unrelated commands.

It does **not** spin up a separate team runtime. OMX uses the normal
`omx team` startup path, then seeds linked team/Ralph state from launch time so
later status, shutdown, and cancel flows can observe one connected run.

- **Linked lifecycle/state:** launch records `linked_ralph=true` in team state,
  creates/updates Ralph state with `linked_team=true`, and later terminal team
  phases propagate into Ralph state. That gives one operator-visible chain for
  resume/cancel/final verification instead of a manual handoff after the fact.
- **Cleanup/shutdown:** linked shutdown uses the Ralph-aware cleanup policy.
  Team cleanup happens first, Ralph is terminalized from the linked team result,
  branch rollback preserves worktree branches, and the run records linked
  terminal metadata plus Ralph cleanup events.
- **Why not just `team` then later `ralph`:** if you start plain `team` and only
  launch Ralph afterward, OMX treats them as separate runs. You do not get
  linked terminal propagation, linked cancel ordering, or automatic Ralph-aware
  shutdown semantics for that original team run.

Use this quick rule:

| Path | Use when |
|---|---|
| `omx team ...` | You want parallel worker coordination only; you will inspect/close the run yourself. |
| `omx team ralph ...` | You already know the team run should roll straight into persistent Ralph verification and linked cleanup. |
| `omx team ...` then later `omx ask ... ralph` | You intentionally want a separate, manual second pass after reviewing team output or changing scope. |

### Ralph Cleanup Policy

When a team runs in ralph mode (`omx team ralph ...`), the shutdown cleanup
applies a dedicated policy that differs from the normal path:

| Behavior | Normal team | Ralph team |
|---|---|---|
| Force shutdown on failure | Throws `shutdown_gate_blocked` | Bypasses gate, logs `ralph_cleanup_policy` event |
| Auto branch deletion | Deletes worktree branches on rollback | Preserves branches (`skipBranchDeletion`) |
| Completion logging | Standard `shutdown_gate` event | Additional `ralph_cleanup_summary` event with task breakdown |

The ralph policy is auto-detected from team mode state (`linked_ralph`) or
can be passed explicitly via `omx team shutdown <name> --ralph`.

Worker CLI selection for team workers:

```bash
OMX_TEAM_WORKER_CLI=auto    # default; uses claude when worker --model contains "claude"
OMX_TEAM_WORKER_CLI=codex   # force Codex CLI workers
OMX_TEAM_WORKER_CLI=claude  # force Claude CLI workers
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # per-worker CLI mix (len=1 or worker count)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # optional: disable adaptive queue->resend fallback
```

Notes:
- Worker launch args are still shared via `OMX_TEAM_WORKER_LAUNCH_ARGS` for model/config inheritance.
- When no explicit worker model is provided, low-complexity worker fallback follows `OMX_DEFAULT_SPARK_MODEL` (legacy alias: `OMX_SPARK_MODEL`).
- `OMX_TEAM_WORKER_CLI_MAP` overrides `OMX_TEAM_WORKER_CLI` for per-worker selection.
- Team mode now allocates `model_reasoning_effort` per teammate from the resolved worker role (`low` / `medium` / `high`) unless an explicit reasoning override already exists in `OMX_TEAM_WORKER_LAUNCH_ARGS`.
- When a worker resolves to a concrete task role, OMX composes a per-worker startup instructions file that layers the corresponding role prompt on top of the shared team worker protocol; explicit `model_instructions_file` launch overrides still win.
- Trigger submission uses adaptive retries by default (queue/submit, then safe clear-line+resend fallback when needed).
- In Claude worker mode, OMX spawns workers as plain `claude` (no extra launch args) and ignores explicit `--model` / `--config` / `--effort` overrides so Claude uses default `settings.json`.

## What `omx setup` writes

- `.omx/setup-scope.json` (persisted setup scope)
- Scope-dependent installs:
  - `user`: `~/.codex/prompts/`, `~/.codex/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`, `~/.codex/AGENTS.md`
  - `project`: `./.codex/prompts/`, `./.codex/skills/`, `./.codex/config.toml`, `./.omx/agents/`, `./AGENTS.md`
- Launch behavior: if persisted scope is `project`, `omx` launch auto-uses `CODEX_HOME=./.codex` (unless `CODEX_HOME` is already set).
- Launch instructions merge `~/.codex/AGENTS.md` (or `CODEX_HOME/AGENTS.md` when overridden) with project `./AGENTS.md`, then append the runtime overlay
- Managed OMX artifacts refresh by default in both interactive and non-interactive runs: prompts, skills, native agent configs, and the managed OMX portion of `config.toml`
- Existing `AGENTS.md` files are never overwritten silently: interactive setup asks before replacing them, non-interactive setup skips replacement unless you pass `--force`
- If a managed file differs and will be overwritten, setup creates a backup first under `.omx/backups/setup/<timestamp>/...` (project scope) or `~/.omx/backups/setup/<timestamp>/...` (user scope)
- Active-session safety still blocks `AGENTS.md` overwrite while an OMX session is running
- `config.toml` updates (for both scopes):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `model = "<OMX_DEFAULT_FRONTIER_MODEL>"` when root `model` is absent
  - if the existing root model matches the legacy pre-frontier default, interactive `omx setup` asks whether to upgrade it to `OMX_DEFAULT_FRONTIER_MODEL`; non-interactive runs preserve the existing model
  - `model_context_window = 1000000` and `model_auto_compact_token_limit = 900000` only when the effective root model matches `OMX_DEFAULT_FRONTIER_MODEL` and both context keys are absent
  - `[features] multi_agent = true, child_agents_md = true`
  - MCP server entries (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - If a shared MCP registry exists at `~/.omx/mcp-registry.json`, setup syncs those entries into a dedicated managed block in `config.toml` (skipping names already defined elsewhere to avoid duplicate TOML tables)
  - User-scoped setup also syncs missing shared MCP entries into `~/.claude/settings.json` without overwriting existing Claude Code MCP server definitions
  - `[tui] status_line`
- Scope-specific `AGENTS.md`
- `.omx/` runtime directories and HUD config
- Default setup output includes a compact per-category refresh summary; `--verbose` adds changed-file detail
- `--force` is reserved for stronger maintenance behavior such as stale/deprecated skill cleanup; it is no longer required for ordinary refresh
- The 1M GPT-5.4 context settings are experimental and can increase usage because requests beyond the standard context budget may count more heavily

## Lightweight AGENTS bootstrap

Use `omx agents-init [path]` when you only want a narrow AGENTS.md bootstrap helper instead of full OMX setup.

- creates or refreshes `AGENTS.md` in the target directory plus its immediate child directories
- skips generated/vendor/tooling directories such as `.git`, `.omx`, `.codex`, `node_modules`, `dist`, and `build`
- preserves the `<!-- OMX:AGENTS-MANUAL:* -->` section on refresh
- skips unmanaged existing `AGENTS.md` files unless you pass `--force`
- does **not** install prompts, skills, config, or replace planning/execution workflows such as `team`, `ralph`, or `ralplan`

Examples:

```bash
omx agents-init .
omx agents-init ./src --dry-run
omx agents-init . --force
```

## Agents and Skills

- Prompts: `prompts/*.md` (installed to `~/.codex/prompts/` for `user`, `./.codex/prompts/` for `project`)
- Skills: `skills/*/SKILL.md` (installed to `~/.codex/skills/` for `user`, `./.codex/skills/` for `project`)

Examples:
- Agents: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Skills: `autopilot`, `plan`, `team`, `ralph`, `ultrawork`, `cancel`

### Notification Setup Skill (`$configure-notifications`)

Use `$configure-notifications` as the unified entry point for notification setup:

- Discord (webhook/bot)
- Telegram (bot)
- Slack (webhook)
- OpenClaw / custom webhook / custom CLI command

Examples:

```text
$configure-notifications "configure discord notifications"
$configure-notifications "configure slack notifications"
$configure-notifications "configure openclaw notifications"
```

For OpenClaw with **clawdbot agent turns** (instead of direct message forwarding),
configure a command gateway using `clawdbot agent --deliver --reply-channel ... --reply-to ...`
and map hook events (`session-start`, `session-idle`, `ask-user-question`, `session-stop`, `session-end`).

For dev teams using `#omc-dev`, the OpenClaw guide includes a dedicated runbook for:
- Korean-only hook responses
- `sessionId` + `tmuxSession` tracing
- `SOUL.md`-based follow-up workflow

See: `docs/openclaw-integration.md` (Dev Guide section).

Required env gates for OpenClaw command mode:

```bash
export OMX_OPENCLAW=1
export OMX_OPENCLAW_COMMAND=1
```

### Visual QA Loop (`$visual-verdict`)

Use `$visual-verdict` when a task depends on visual fidelity (reference image(s) + generated screenshot).

- Return structured JSON: `score`, `verdict`, `category_match`, `differences[]`, `suggestions[]`, `reasoning`
- Recommended pass threshold: **90+**
- For visual tasks, run `$visual-verdict` every iteration before the next edit
- Use pixel diff / pixelmatch overlays as **secondary debugging aids** (not the primary pass/fail signal)

## Project Layout

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

## Development

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run lint
npm run build:full
npm test
```

## Documentation

- **[Full Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** - Complete guide
- **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** - All `omx` commands, flags, and tools
- **[Notifications Guide](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** - Discord, Telegram, Slack, OpenClaw, and custom command/webhook setup
- **[Recommended Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** - Battle-tested skill chains for common tasks
- **[Prompt Guidance Contract](./docs/prompt-guidance-contract.md)** - Contributor reference for the GPT-5.4 prompt behavior contract
- **[Release Notes](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** - What's new in each version

## Notes

- Full changelog: `CHANGELOG.md`
- Migration guide (post-v0.4.4 mainline): `docs/migration-mainline-post-v0.4.4.md`
- Coverage and parity notes: `COVERAGE.md`
- Hook extension workflow: `docs/hooks-extension.md`
- OpenClaw integration examples: `docs/openclaw-integration.md`
- Setup and contribution details: `CONTRIBUTING.md`

## Maintainers

- [Yeachan-Heo](https://github.com/Yeachan-Heo)
- [HaD0Yun](https://github.com/HaD0Yun)

## Acknowledgments

Inspired by [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), adapted for Codex CLI.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=Date)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&Date)

## License

MIT
