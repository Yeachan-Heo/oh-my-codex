# oh-my-codex: Multi-Agent Orchestration for OpenAI Codex CLI

**Created:** 2026-02-12
**Status:** Draft - Awaiting Approval
**Complexity:** HIGH
**Estimated Phases:** 4 (incremental delivery)

---

## Context

oh-my-claudecode (OMC) is a multi-agent orchestration layer for Claude Code that provides 30+ specialized agent roles, workflow skills, MCP-based tooling, and persistent state management. Its power derives from lifecycle hooks that intercept session start, tool use (pre/post), and user prompt submission to inject context back into the conversation.

The goal of oh-my-codex is to bring equivalent multi-agent orchestration to OpenAI's Codex CLI. The fundamental challenge is that Codex CLI's hook system is architecturally different: hooks are post-only, fire-and-forget, and cannot inject context back into the conversation. This plan addresses that gap through a hybrid strategy.

## Work Objectives

1. Deliver a working multi-agent orchestration layer for Codex CLI
2. Maximize use of existing Codex CLI extension points (Skills, MCP, AGENTS.md, custom prompts)
3. Minimize fork surface area -- only fork what cannot be achieved through add-on mechanisms
4. Establish a sustainable upstream contribution path to reduce fork divergence over time
5. Achieve feature parity with OMC's core capabilities in phases, not all at once

## Architecture Decision: Thin Fork + Add-On Hybrid

### Why not pure add-on?

The critical blocker is hook capability. OMC's orchestration depends on:

1. **Session-start injection** -- Loading the full orchestration prompt (CLAUDE.md equivalent) at startup. Codex CLI loads AGENTS.md at startup, so this IS achievable without a fork.
2. **Pre-tool-use interception** -- Keyword detection, mode enforcement, subagent tracking. Codex CLI has NO pre-tool hooks. This REQUIRES a fork or upstream contribution.
3. **User-prompt-submit interception** -- Skill invocation triggers, keyword detection. Codex CLI has NO user-prompt hooks. This REQUIRES a fork or upstream contribution.
4. **Context injection** -- Hooks returning data that gets injected as system messages. Codex CLI hooks cannot return data to the conversation. This REQUIRES a fork or upstream contribution.

### Why not a full fork?

Codex CLI is a fast-moving Rust + TypeScript codebase. A full fork creates unsustainable merge burden. Instead:

- **Fork only the hooks crate** (`codex-rs/hooks/`) to add pre-event hooks and context injection
- **Everything else is add-on**: Skills as SKILL.md files, MCP servers via config.toml, agent prompts as custom prompts, state management as an MCP server

### The Hybrid Architecture

```
+------------------------------------------------------------------+
|                        oh-my-codex (npm package)                  |
|                                                                   |
|  +------------------+  +------------------+  +-----------------+  |
|  | Skills (.md)     |  | Agent Prompts    |  | MCP Servers     |  |
|  | SKILL.md format  |  | ~/.codex/prompts |  | State, LSP, AST |  |
|  | ~/.agents/skills |  | Slash commands   |  | config.toml     |  |
|  +------------------+  +------------------+  +-----------------+  |
|                                                                   |
|  +------------------+  +------------------+  +-----------------+  |
|  | AGENTS.md        |  | Config Generator |  | CLI Wrapper     |  |
|  | Orchestration    |  | config.toml      |  | omx / codex-omx |  |
|  | instructions     |  | profiles, MCP    |  | Thin shim       |  |
|  +------------------+  +------------------+  +-----------------+  |
+------------------------------------------------------------------+
                              |
                    +---------+---------+
                    |   codex-rs fork   |
                    |   (hooks crate)   |
                    |                   |
                    | + PreToolUse      |
                    | + UserPromptSubmit|
                    | + SessionStart    |
                    | + Context inject  |
                    +-------------------+
                              |
                    +---------+---------+
                    |  Upstream Codex   |
                    |  CLI (everything  |
                    |  else untouched)  |
                    +-------------------+
```

## Guardrails

### Must Have
- Works with standard Codex CLI for Phase 1 features (skills, MCP, agents, state)
- Fork changes are isolated to hooks crate only
- All fork changes are submitted as upstream PRs
- `omx setup` command that configures everything automatically
- Graceful degradation: if running on upstream (unforkd) Codex, advanced features (keyword detection, mode enforcement) are disabled but basic features work

### Must NOT Have
- Full fork of Codex CLI -- only the hooks crate
- Breaking changes to existing Codex CLI behavior
- Dependency on specific Codex CLI internal APIs beyond hooks
- Hard requirement on the fork for basic functionality

---

## Task Flow

```
Phase 1 (Add-On Only)          Phase 2 (Fork: Hooks)
No fork required                Hooks crate changes
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Skills + MCP + Agents + State   PreToolUse + UserPromptSubmit
     |                               |
     v                               v
Phase 3 (Orchestration)        Phase 4 (Upstream)
Full multi-agent workflows      Contribute hooks upstream
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Modes, teams, pipelines         PRs, RFC, community
```

---

## Phase 1: Add-On Foundation (No Fork Required)

**Goal:** Deliver a working `omx` CLI that sets up skills, MCP servers, agent prompts, and state management using only existing Codex CLI extension points.

### Task 1.1: Project Scaffolding and CLI Wrapper

**What:** Create the npm package structure with a thin CLI wrapper (`omx`) that orchestrates setup and delegates to `codex`.

**Files to create:**
- `package.json` -- npm package with `bin: { "omx": "./bin/omx.js" }`
- `bin/omx.js` -- CLI entry point
- `src/cli/index.ts` -- Command router (setup, doctor, help, etc.)
- `src/cli/setup.ts` -- Automated setup: copies skills, configures MCP, generates AGENTS.md
- `src/cli/doctor.ts` -- Validates installation and configuration
- `tsconfig.json`, `.eslintrc`, basic tooling

**Acceptance Criteria:**
- `npm install -g oh-my-codex` installs the package
- `omx setup` creates all necessary config files
- `omx doctor` reports installation health
- `omx version` shows version info
- Package has zero runtime dependencies beyond Node.js stdlib (MCP servers are separate)

### Task 1.2: Agent Definitions as Custom Prompts

**What:** Port OMC's 30+ agent role definitions to Codex CLI's custom prompt format (`~/.codex/prompts/*.md`).

**Mapping:**
- OMC agent definitions (TypeScript objects with system prompts) -> Markdown files with YAML frontmatter
- Each agent becomes a slash command: `/architect`, `/executor`, `/reviewer`, etc.
- Frontmatter includes `description` and `argument-hint` for discoverability

**Files to create:**
- `src/agents/definitions.ts` -- Canonical agent role definitions (shared source of truth)
- `prompts/*.md` -- Generated prompt files for each agent role (30+)
- `src/generators/prompts.ts` -- Generator that produces prompt .md files from definitions

**Acceptance Criteria:**
- Running `/architect` in Codex CLI loads the architect system prompt
- All 30+ agent roles are available as slash commands
- Agent prompts reference the oh-my-codex orchestration context
- `omx setup` installs prompts to `~/.codex/prompts/`

### Task 1.3: Skills as SKILL.md Files

**What:** Port OMC's workflow skills to Codex CLI's SKILL.md format.

**Mapping:**
- OMC skills (markdown files loaded by Skill tool) -> SKILL.md with frontmatter
- Skills that depend on hooks (keyword detection, mode enforcement) are deferred to Phase 3
- Skills that are self-contained prompts port directly

**Phase 1 skills (no hook dependency):**
- `autopilot` -- Autonomous execution workflow
- `plan` -- Strategic planning
- `code-review` -- Comprehensive code review
- `research` -- Parallel research
- `tdd` -- Test-driven development guide
- `deepinit` -- Deep codebase initialization

**Files to create:**
- `skills/*.md` -- SKILL.md files for each portable skill
- `src/generators/skills.ts` -- Generator that produces SKILL.md files

**Acceptance Criteria:**
- `/skills` in Codex CLI lists all oh-my-codex skills
- Invoking a skill loads the full workflow prompt
- Skills that reference MCP tools include the `agents/openai.yaml` dependency
- `omx setup` installs skills to `~/.agents/skills/`

### Task 1.4: MCP Servers for Tooling

**What:** Build MCP servers that provide the tooling layer: state management, project memory, notepad, and code intelligence.

**MCP servers to build:**
1. **omx-state** -- State read/write/clear/list for workflow modes (`.omx/state/`)
2. **omx-memory** -- Project memory and notepad (`.omx/project-memory.json`, `.omx/notepad.md`)
3. **omx-codeintel** -- LSP integration and AST grep (can wrap existing tools or reuse OMC's)

**Files to create:**
- `src/mcp/state-server.ts` -- State management MCP server
- `src/mcp/memory-server.ts` -- Project memory MCP server
- `src/mcp/codeintel-server.ts` -- Code intelligence MCP server
- `src/mcp/shared/protocol.ts` -- Shared MCP protocol utilities

**Acceptance Criteria:**
- MCP servers start via stdio transport
- `omx setup` adds MCP server entries to `~/.codex/config.toml`
- State server supports: `state_read`, `state_write`, `state_clear`, `state_list_active`
- Memory server supports: `project_memory_read`, `project_memory_write`, `notepad_read`, `notepad_write`
- Code intelligence server provides LSP hover, goto-definition, find-references, diagnostics
- All servers pass MCP protocol compliance tests

### Task 1.5: AGENTS.md Orchestration Prompt

**What:** Create the AGENTS.md file that serves as the orchestration brain -- equivalent to OMC's injected CLAUDE.md.

**Key difference:** Unlike OMC which injects CLAUDE.md via a session-start hook, Codex CLI reads AGENTS.md natively at session start. This is actually simpler and requires no hook.

**Content to include:**
- Operating principles for multi-agent orchestration
- Agent catalog with role descriptions and when to use each
- MCP tool routing (which MCP server provides which tools)
- Skill catalog with invocation patterns
- Delegation rules (when to use sub-agents vs direct action)
- State management conventions
- Verification protocols

**Files to create:**
- `src/generators/agents-md.ts` -- Generator that produces AGENTS.md from structured data
- `templates/AGENTS.md.hbs` -- Template for AGENTS.md generation

**Acceptance Criteria:**
- `omx setup` generates AGENTS.md in the project root
- AGENTS.md correctly references all installed MCP tools, skills, and agent prompts
- Content is under 8000 tokens (Codex CLI context budget consideration)
- Running Codex CLI in a project with this AGENTS.md enables multi-agent orchestration

### Task 1.6: Config Generator

**What:** Generate `~/.codex/config.toml` entries for MCP servers, feature flags, and model routing.

**Config entries needed:**
- `[mcp_servers.omx_state]` -- State management server
- `[mcp_servers.omx_memory]` -- Project memory server
- `[mcp_servers.omx_codeintel]` -- Code intelligence server
- Feature flags: `collab = true`, `child_agents_md = true`
- Model routing instructions in `developer_instructions`

**Files to create:**
- `src/config/generator.ts` -- Config.toml generator/merger
- `src/config/schema.ts` -- Type definitions for Codex config

**Acceptance Criteria:**
- `omx setup` merges MCP server config into existing config.toml without clobbering user settings
- Config includes all required MCP servers with correct stdio transport commands
- Feature flags are set for sub-agent and hierarchical AGENTS.md support
- `omx doctor` validates config correctness

---

## Phase 2: Hooks Crate Enhancement (Minimal Fork)

**Goal:** Add pre-event hooks and context injection to Codex CLI's hooks crate, enabling keyword detection, mode enforcement, and skill auto-invocation.

### Task 2.1: Fork Strategy and Repository Setup

**What:** Create a minimal fork of codex-rs focused exclusively on the hooks crate.

**Strategy:**
- Fork `openai/codex` to `oh-my-codex/codex` (or similar)
- Use git subtree or sparse checkout to isolate `codex-rs/hooks/`
- Set up CI that runs upstream Codex CLI tests to detect breakage
- Maintain a `FORK_CHANGES.md` documenting every deviation from upstream
- Rebase strategy: rebase fork changes onto upstream releases weekly

**Acceptance Criteria:**
- Fork exists with clear documentation of changes
- CI runs upstream test suite and oh-my-codex-specific tests
- `FORK_CHANGES.md` is maintained and accurate
- Rebase onto upstream succeeds without manual intervention (or documents conflicts)

### Task 2.2: Add Pre-Event Hook Types

**What:** Extend the hooks crate to support `BeforeToolUse`, `UserPromptSubmit`, and `SessionStart` hook events.

**Implementation approach:**
- Add new variants to `HookEvent` enum: `BeforeToolUse`, `UserPromptSubmit`, `SessionStart`
- Extend `HookPayload` to carry tool name, tool input (for BeforeToolUse), and user prompt text (for UserPromptSubmit)
- Add a `notify_and_collect` path alongside existing `notify` (fire-and-forget) that waits for the hook process to complete and captures stdout
- Hook stdout is parsed as JSON; a `context_injection` field, if present, is prepended to the next assistant turn as a system message
- Timeout and error handling: hooks that exceed timeout or fail are logged and skipped (no conversation blocking)

**Files to modify (in fork):**
- `codex-rs/hooks/src/lib.rs` -- New event types, payload extensions
- `codex-rs/hooks/src/notify.rs` -- Add `notify_and_collect` function
- `codex-rs/hooks/src/config.rs` -- Hook configuration for new event types
- Integration point in the main agent loop where tool calls are dispatched

**Acceptance Criteria:**
- `BeforeToolUse` fires before each tool execution with tool name and input in payload
- `UserPromptSubmit` fires when the user submits a prompt with prompt text in payload
- `SessionStart` fires at session initialization with session metadata in payload
- Hooks can return JSON with `context_injection` field
- Context injection content appears as a system message in the conversation
- Hooks that timeout (default 5s) are skipped with a warning log
- All existing hook behavior is unchanged (backward compatible)
- Upstream Codex CLI test suite passes without modification

### Task 2.3: External Hook Configuration

**What:** Extend `config.toml` to allow registering external hook commands (not just Rust callbacks).

**Implementation:**
- Add `[hooks]` section to config.toml schema
- Each hook entry specifies: event type, command (argv), timeout, enabled flag
- Hook commands receive JSON payload on stdin, return JSON on stdout
- This replaces the current Rust-only `HookFn` registration with a polyglot mechanism

**Config format:**
```toml
[hooks.omx_pre_tool]
event = "BeforeToolUse"
command = ["node", "~/.codex/hooks/omx-hook.js"]
timeout_ms = 5000
enabled = true

[hooks.omx_prompt]
event = "UserPromptSubmit"
command = ["node", "~/.codex/hooks/omx-hook.js"]
timeout_ms = 3000
enabled = true
```

**Files to modify (in fork):**
- `codex-rs/hooks/src/config.rs` -- External hook configuration parsing
- `codex-rs/hooks/src/external.rs` -- New: external hook execution (spawn, stdin/stdout, timeout)
- Config schema documentation

**Acceptance Criteria:**
- External hooks can be registered via config.toml
- Hook commands receive well-formed JSON on stdin
- Hook stdout is captured and parsed for context injection
- Timeout enforcement works correctly
- Hooks can be enabled/disabled per-entry
- Configuration validates at startup with clear error messages

### Task 2.4: oh-my-codex Hook Handlers

**What:** Build the Node.js hook handlers that implement keyword detection, mode enforcement, and context injection.

**Files to create:**
- `src/hooks/handler.ts` -- Main hook entry point (reads stdin JSON, routes by event type)
- `src/hooks/session-start.ts` -- Session initialization: load project memory, set up state
- `src/hooks/pre-tool-use.ts` -- Keyword detection, subagent tracking, mode enforcement
- `src/hooks/user-prompt.ts` -- Skill invocation triggers, keyword detection
- `src/hooks/context.ts` -- Context injection builder (formats system-reminder content)

**Acceptance Criteria:**
- Hook handler processes all three event types correctly
- Keyword detection triggers skill invocation (e.g., typing "autopilot" triggers the autopilot skill)
- Subagent tracking records agent spawns and completions
- Mode enforcement prevents conflicting modes from running simultaneously
- Context injection returns well-formed JSON with `context_injection` field
- Handler completes within 3s for all event types
- Graceful error handling: crashes produce a log entry, not a conversation failure

---

## Phase 3: Full Orchestration

**Goal:** With hooks in place, build the complete multi-agent orchestration workflows: modes, teams, pipelines, and verification loops.

### Task 3.1: Workflow Modes

**What:** Implement the core execution modes: autopilot, ralph (persistence loop), ultrawork (max parallelism), ecomode (token-efficient).

**Implementation:** Each mode is a combination of:
- A skill prompt (Phase 1) that defines the workflow
- State management (Phase 1 MCP) that tracks mode lifecycle
- Hook behavior (Phase 2) that enforces mode rules and injects mode-specific context

**Files to create:**
- `src/modes/autopilot.ts` -- Autopilot mode logic
- `src/modes/ralph.ts` -- Ralph persistence loop
- `src/modes/ultrawork.ts` -- Parallel execution orchestration
- `src/modes/ecomode.ts` -- Token-efficient model routing
- `src/modes/base.ts` -- Shared mode lifecycle (start, enforce, cancel)

**Acceptance Criteria:**
- `autopilot` mode executes from idea to working code with verification
- `ralph` mode persists across failures and self-corrects
- `ultrawork` mode runs independent tasks in parallel
- `ecomode` routes to cheaper models for simple tasks
- Modes can be started, cancelled, and resumed
- Only one exclusive mode runs at a time (enforced via hooks)

### Task 3.2: Sub-Agent Orchestration

**What:** Leverage Codex CLI's `collab` feature for multi-agent coordination with oh-my-codex's role specialization.

**Implementation:**
- When the orchestration prompt instructs "delegate to executor," Codex CLI uses its native sub-agent capability
- The sub-agent inherits the agent prompt for its role (from Phase 1.2)
- oh-my-codex tracks sub-agent lifecycle via hooks (Phase 2)
- Results flow back through Codex CLI's native sub-agent communication

**Files to create:**
- `src/orchestration/delegation.ts` -- Delegation logic and agent selection
- `src/orchestration/tracking.ts` -- Sub-agent lifecycle tracking
- `src/orchestration/model-routing.ts` -- Model selection per agent role

**Acceptance Criteria:**
- Delegation to specialized agents works via Codex CLI's native sub-agent system
- Agent role prompts are loaded correctly for sub-agents
- Sub-agent tracking records start/complete/fail events
- Model routing suggests appropriate model per agent role
- Parallel sub-agent execution works for independent tasks

### Task 3.3: Verification and Quality Loops

**What:** Implement the verification protocol: evidence-backed confirmation that work is complete.

**Files to create:**
- `src/verification/verifier.ts` -- Verification orchestration
- `src/verification/evidence.ts` -- Evidence collection (test results, type checks, lint)
- `src/verification/loop.ts` -- Fix-verify loop with bounded retries

**Acceptance Criteria:**
- Verifier agent checks completion claims against evidence
- Evidence includes: test pass/fail, type check results, lint results
- Fix-verify loop retries up to 3 times before escalating
- Verification results are persisted in state for audit

---

## Phase 4: Upstream Contribution

**Goal:** Contribute hook enhancements back to upstream Codex CLI, reducing fork surface to zero.

### Task 4.1: RFC and Community Engagement

**What:** Write an RFC for the Codex CLI hooks enhancement and engage with the upstream community.

**Deliverables:**
- RFC document explaining the use case (multi-agent orchestration), the proposed API, and backward compatibility
- Working implementation as evidence (our fork)
- Performance benchmarks showing hook overhead is negligible
- Community discussion on openai/codex GitHub

**Acceptance Criteria:**
- RFC submitted as GitHub discussion or PR to openai/codex
- RFC references working implementation with benchmarks
- Community feedback incorporated into proposal
- Clear migration path for oh-my-codex users if upstream accepts

### Task 4.2: Upstream PR

**What:** Submit the hooks crate changes as a PR to openai/codex.

**PR scope:**
- New hook event types (BeforeToolUse, UserPromptSubmit, SessionStart)
- External hook configuration in config.toml
- Context injection mechanism
- Tests and documentation

**Acceptance Criteria:**
- PR passes upstream CI
- Changes are backward compatible
- Documentation is complete
- PR is reviewed and iterated on based on feedback

### Task 4.3: Fork Sunset

**What:** Once upstream accepts hooks changes, migrate oh-my-codex to use upstream Codex CLI exclusively.

**Acceptance Criteria:**
- oh-my-codex works with upstream Codex CLI (no fork)
- Migration guide for users on the fork
- Fork repository archived with redirect to upstream

---

## Success Criteria

1. **Phase 1 complete:** `omx setup` configures a working multi-agent environment using only upstream Codex CLI. Skills, MCP tools, agent prompts, and AGENTS.md orchestration all functional.
2. **Phase 2 complete:** Hook handlers enable keyword detection, mode enforcement, and context injection. Fork changes are minimal and isolated.
3. **Phase 3 complete:** Full workflow modes (autopilot, ralph, ultrawork) operational. Sub-agent delegation working. Verification loops functional.
4. **Phase 4 complete:** Hook changes accepted upstream. Fork sunset. oh-my-codex is a pure add-on.

## Key Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Upstream Codex CLI changes break fork | High | Medium | Weekly rebase CI, minimal fork surface, isolate to hooks crate only |
| Upstream rejects hooks RFC | Medium | Medium | oh-my-codex continues working on fork; hooks design is clean enough to maintain independently |
| Codex CLI sub-agent system insufficient for orchestration | High | Low | Phase 1 validates sub-agent capabilities early; fallback is MCP-based agent communication |
| AGENTS.md context budget too small for orchestration prompt | Medium | Medium | Tiered AGENTS.md: core orchestration in root, role-specific in hierarchical child files (child_agents_md flag) |
| MCP server startup latency impacts UX | Low | Medium | Lazy initialization, connection pooling, health checks in `omx doctor` |
| Skills format incompatibility between OMC and Codex | Low | Low | Generator abstracts differences; canonical definitions in TypeScript, generated outputs per platform |

## Open Questions

See `.omc/plans/open-questions.md` for tracked items.
