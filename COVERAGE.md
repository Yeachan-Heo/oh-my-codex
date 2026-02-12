# oh-my-codex Feature Coverage Matrix

**Target: >=90% parity with oh-my-claudecode (excluding MCP tools)**
**Last Updated:** 2026-02-12

## Coverage Summary

| Category | OMC Features | OMX Implemented | Coverage |
|----------|-------------|-----------------|----------|
| Agent Definitions | 30 | 30 | 100% |
| Skills/Commands | 39 | 39 | 100% |
| AGENTS.md (CLAUDE.md equiv) | 1 | 1 | 100% |
| CLI (setup/doctor/help/etc) | 6 | 6 | 100% |
| Config Generation | 1 | 1 | 100% |
| Mode State Management | 9 modes | 9 modes | 100% |
| Project Memory | 4 tools | 4 tools | 100% |
| Notepad | 4 tools | 4 tools | 100% |
| Verification Protocol | 1 | 1 | 100% |
| Notification System | 3 channels | 3 channels | 100% |
| Keyword Detection | 17 keywords | 17 keywords | 100% |
| Hook Pipeline | 9 events | 4 full + 3 partial | ~60% |
| HUD/Status Line | 1 | 0 (not portable) | 0% |
| Subagent Tracking | 1 | partial (via collab) | 50% |
| **TOTAL (excl MCP)** | | | **~92%** |

## Detailed Feature Mapping

### Agent Definitions (30/30 = 100%)

| OMC Agent | OMX Status | Mechanism |
|-----------|-----------|-----------|
| analyst | DONE | ~/.codex/prompts/analyst.md |
| api-reviewer | DONE | ~/.codex/prompts/api-reviewer.md |
| architect | DONE | ~/.codex/prompts/architect.md |
| build-fixer | DONE | ~/.codex/prompts/build-fixer.md |
| code-reviewer | DONE | ~/.codex/prompts/code-reviewer.md |
| critic | DONE | ~/.codex/prompts/critic.md |
| debugger | DONE | ~/.codex/prompts/debugger.md |
| deep-executor | DONE | ~/.codex/prompts/deep-executor.md |
| dependency-expert | DONE | ~/.codex/prompts/dependency-expert.md |
| designer | DONE | ~/.codex/prompts/designer.md |
| executor | DONE | ~/.codex/prompts/executor.md |
| explore | DONE | ~/.codex/prompts/explore.md |
| git-master | DONE | ~/.codex/prompts/git-master.md |
| information-architect | DONE | ~/.codex/prompts/information-architect.md |
| performance-reviewer | DONE | ~/.codex/prompts/performance-reviewer.md |
| planner | DONE | ~/.codex/prompts/planner.md |
| product-analyst | DONE | ~/.codex/prompts/product-analyst.md |
| product-manager | DONE | ~/.codex/prompts/product-manager.md |
| qa-tester | DONE | ~/.codex/prompts/qa-tester.md |
| quality-reviewer | DONE | ~/.codex/prompts/quality-reviewer.md |
| quality-strategist | DONE | ~/.codex/prompts/quality-strategist.md |
| researcher | DONE | ~/.codex/prompts/researcher.md |
| scientist | DONE | ~/.codex/prompts/scientist.md |
| security-reviewer | DONE | ~/.codex/prompts/security-reviewer.md |
| style-reviewer | DONE | ~/.codex/prompts/style-reviewer.md |
| test-engineer | DONE | ~/.codex/prompts/test-engineer.md |
| ux-researcher | DONE | ~/.codex/prompts/ux-researcher.md |
| verifier | DONE | ~/.codex/prompts/verifier.md |
| vision | DONE | ~/.codex/prompts/vision.md |
| writer | DONE | ~/.codex/prompts/writer.md |

### Skills (39/39 = 100%)

| OMC Skill | OMX Status | Mechanism |
|-----------|-----------|-----------|
| autopilot | DONE | ~/.agents/skills/autopilot/SKILL.md |
| ralph | DONE | ~/.agents/skills/ralph/SKILL.md |
| ultrawork | DONE | ~/.agents/skills/ultrawork/SKILL.md |
| ecomode | DONE | ~/.agents/skills/ecomode/SKILL.md |
| plan | DONE | ~/.agents/skills/plan/SKILL.md |
| ralplan | DONE | ~/.agents/skills/ralplan/SKILL.md |
| team | DONE | ~/.agents/skills/team/SKILL.md |
| pipeline | DONE | ~/.agents/skills/pipeline/SKILL.md |
| ultraqa | DONE | ~/.agents/skills/ultraqa/SKILL.md |
| ultrapilot | DONE | ~/.agents/skills/ultrapilot/SKILL.md |
| research | DONE | ~/.agents/skills/research/SKILL.md |
| code-review | DONE | ~/.agents/skills/code-review/SKILL.md |
| security-review | DONE | ~/.agents/skills/security-review/SKILL.md |
| tdd | DONE | ~/.agents/skills/tdd/SKILL.md |
| deepinit | DONE | ~/.agents/skills/deepinit/SKILL.md |
| deepsearch | DONE | ~/.agents/skills/deepsearch/SKILL.md |
| analyze | DONE | ~/.agents/skills/analyze/SKILL.md |
| build-fix | DONE | ~/.agents/skills/build-fix/SKILL.md |
| cancel | DONE | ~/.agents/skills/cancel/SKILL.md |
| doctor | DONE | ~/.agents/skills/doctor/SKILL.md |
| help | DONE | ~/.agents/skills/help/SKILL.md |
| hud | DONE | ~/.agents/skills/hud/SKILL.md |
| learner | DONE | ~/.agents/skills/learner/SKILL.md |
| note | DONE | ~/.agents/skills/note/SKILL.md |
| trace | DONE | ~/.agents/skills/trace/SKILL.md |
| skill | DONE | ~/.agents/skills/skill/SKILL.md |
| frontend-ui-ux | DONE | ~/.agents/skills/frontend-ui-ux/SKILL.md |
| git-master | DONE | ~/.agents/skills/git-master/SKILL.md |
| review | DONE | ~/.agents/skills/review/SKILL.md |
| ralph-init | DONE | ~/.agents/skills/ralph-init/SKILL.md |
| release | DONE | ~/.agents/skills/release/SKILL.md |
| omx-setup | DONE | ~/.agents/skills/omx-setup/SKILL.md |
| configure-telegram | DONE | ~/.agents/skills/configure-telegram/SKILL.md |
| configure-discord | DONE | ~/.agents/skills/configure-discord/SKILL.md |
| writer-memory | DONE | ~/.agents/skills/writer-memory/SKILL.md |
| project-session-manager | DONE | ~/.agents/skills/project-session-manager/SKILL.md |
| psm | DONE | ~/.agents/skills/psm/SKILL.md |
| swarm | DONE | ~/.agents/skills/swarm/SKILL.md |
| learn-about-omx | DONE | ~/.agents/skills/learn-about-omx/SKILL.md |

### Hook Pipeline (4 full + 3 partial out of 9 = ~60%)

| OMC Hook Event | OMX Equivalent | Capability |
|---------------|---------------|------------|
| SessionStart | AGENTS.md native loading | FULL |
| PreToolUse | AGENTS.md inline guidance | PARTIAL (no interception) |
| PostToolUse | notify config hook | PARTIAL (no context injection) |
| UserPromptSubmit | AGENTS.md self-detection | PARTIAL (model-side detection) |
| SubagentStart | Codex CLI collab native | FULL |
| SubagentStop | Codex CLI collab native | FULL |
| PreCompact | Not available | NONE |
| Stop | notify config | FULL |
| SessionEnd | Not directly available | NONE |

### Infrastructure

| Component | OMC | OMX Status |
|-----------|-----|-----------|
| CLI (setup) | DONE | DONE |
| CLI (doctor) | DONE | DONE |
| CLI (help) | DONE | DONE |
| CLI (version) | DONE | DONE |
| CLI (status) | DONE | DONE |
| CLI (cancel) | DONE | DONE |
| Config generator | DONE | DONE |
| AGENTS.md template | DONE | DONE |
| State MCP server | DONE | DONE |
| Memory MCP server | DONE | DONE |
| Notify hook script | DONE | DONE |
| Keyword detector | DONE | DONE |
| Hook emulation layer | N/A | DONE |
| Mode base lifecycle | DONE | DONE |
| Verification protocol | DONE | DONE |
| Notification system | DONE | DONE |

## Known Gaps

1. **Pre-tool interception** - Cannot intercept tool calls before execution. Workaround: AGENTS.md instructs model to self-moderate.
2. **Context injection from hooks** - Cannot inject context back into conversation from hooks. Workaround: state files + AGENTS.md instructions.
3. **HUD/Status line** - Codex CLI's TUI doesn't expose status line extension. Blocked.
4. **PreCompact hook** - Codex manages compaction internally. No extension point.
5. **Session end** - No direct session-end event. notify on last turn is closest.

## Upstream Contribution Path

To achieve 100% hook parity, these changes need to be contributed to Codex CLI:
1. Add `BeforeToolUse` hook event to `codex-rs/hooks/`
2. Add `UserPromptSubmit` hook event
3. Add external hook configuration in `config.toml` (currently only `notify`)
4. Add hook context injection (hook stdout -> system message)

RFC tracking: TBD
