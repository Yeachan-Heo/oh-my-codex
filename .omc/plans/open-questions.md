# Open Questions

## oh-my-codex - 2026-02-12

### Architecture
- [ ] Should the fork target a specific Codex CLI release tag or track main? -- Affects rebase stability and user expectations for compatibility.
- [ ] Is Codex CLI's `collab` sub-agent system mature enough for delegated multi-agent workflows, or do we need MCP-based agent communication as a fallback? -- Determines whether Phase 3 sub-agent orchestration is viable on native primitives.
- [ ] What is the practical token budget for AGENTS.md in Codex CLI? -- If too constrained, the orchestration prompt must be split across hierarchical child AGENTS.md files.

### Hooks
- [ ] Will OpenAI be receptive to external hook contributions to codex-rs? -- If not, the fork becomes a long-term maintenance burden rather than a temporary bridge.
- [ ] Should hook context injection use a dedicated system message type or piggyback on existing developer_instructions? -- Affects how cleanly injected context integrates with the conversation.
- [ ] What is the acceptable latency budget for pre-tool-use hooks? -- 5s timeout proposed, but this may be too generous for interactive use.

### Compatibility
- [ ] Should oh-my-codex maintain API compatibility with oh-my-claudecode's state format and project memory schema? -- Enables users to share project memory across both tools.
- [ ] Should skills be written once and generated for both platforms, or maintained independently? -- Affects whether the canonical source is TypeScript definitions or markdown files.
- [ ] How should model routing work given Codex CLI's model provider system vs OMC's direct model parameter? -- Different mechanisms for the same concept.

### Scope
- [ ] Which OMC skills should be excluded entirely (not just deferred) because they depend on Claude Code-specific capabilities? -- Prevents wasted effort porting impossible features.
- [ ] Should oh-my-codex support the team/swarm coordination modes, or are those too tightly coupled to Claude Code's native Team API? -- Team mode uses Claude Code primitives that have no Codex equivalent.
- [ ] What is the priority ordering of Phase 1 tasks if resources are constrained? -- Determines minimum viable delivery.
