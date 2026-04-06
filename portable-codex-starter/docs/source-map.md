# Source Map

This file records what was taken from `oh-my-codex`, what was adapted, and what was deliberately excluded.

## Safe carry-over sources

- `prompts/*.md`
  Carried over as source material for custom agents.
- `docs/prompt-guidance-fragments/*.md`
  Used as guidance for concise, evidence-driven portable behavior.
- `docs/shared/agent-tiers.md`
  Used for portable role/tier reasoning.
- `src/agents/definitions.ts`
  Used as the role catalog reference.
- `templates/AGENTS.md`
  Used as the structural basis for the new portable `AGENTS.md`.

## Adapted for portability

- `AGENTS.md`
  Rewritten to remove OMX CLI, tmux, runtime overlays, `.omx/` state, and OMX-only workflow commands.
- `.codex/config.toml`
  Replaced OMX-managed config generation with safe portable defaults plus small native subagent limits.
- `.codex/mcp-servers.example.toml`
  Added as a safe MCP template layer so external context can be enabled intentionally instead of being hardwired.
- `.codex/agents/*.toml`
  Generated from the prompt catalog with OMX-only lines removed.
- `prompts/explore-harness.md`
  Reinterpreted as a shell-first, read-only Codex agent instead of an OMX command harness.
- `prompts/qa-tester.md`
  Rewritten from a tmux-dependent runtime tester into a shell-driven smoke/integration verifier that works in Codespaces and plain Codex sessions.
- `prompts/team-executor.md`
  Rewritten from an OMX worker surface into a bounded native Codex execution lane.
- `prompts/team-orchestrator.md`
  Rewritten from OMX team coordination guidance into a native Codex subagent orchestration role.
- `.agents/skills/*`
  Rewritten as portable skills that assume native Codex behavior, not the OMX runtime.
- `.devcontainer/**`
  Added as a portable Codespaces bootstrap layer that avoids OMX-specific runtime assumptions.
- `.github/copilot-instructions.md`
  Added as a portable GitHub Copilot repository-wide instruction layer.
- `.github/instructions/*.instructions.md`
  Added as portable path-specific GitHub Copilot guidance for starter maintenance and downstream reuse.
- `.github/agents/*.agent.md`
  Added as lightweight GitHub Copilot custom agents for maintaining the portable pack.
- `.github/skills/*`
  Added as portable GitHub Copilot skill playbooks for repeated testing, deployment, incident, and security procedures.
- `.github/hooks/**`
  Added as a minimal local-only GitHub Copilot hook policy and audit layer.
- `.github/workflows/copilot-setup-steps.yml`
  Added as a portable GitHub Copilot cloud-agent bootstrap workflow.
- `.github/workflows/portable-quality-gate.yml`
  Added as a portable PR quality gate workflow that validates common scripts and starter scaffolding.

## Deliberately excluded

- `src/cli/**`
  OMX launcher, setup, doctor, resume, team, ralph, and runtime entrypoints depend on the `omx` command.
- `src/team/**`
  Team mode depends on tmux, shared state directories, and OMX-specific lifecycle rules.
- `src/hooks/**`
  Hook overlays and runtime injection depend on OMX-managed startup.
- `src/runtime/**`, `src/subagents/**`, `src/mcp/**`
  These are OMX runtime implementation details, not portable Codex assets.
- `crates/**`
  Native sidecars are OMX-specific.
- Notification and OpenClaw docs
  Useful operationally, but not part of a portable no-OMX starter.

## Key portability decisions

- Skills use `.agents/skills/`, not `.codex/skills/`.
- Custom agents use `.codex/agents/`.
- Prompt sources are preserved, but generated agent instructions are sanitized.
- The starter favors native Codex subagents and plain repository-local files over runtime state machines.
- Some formerly OMX-only roles are kept as portable approximations rather than exact runtime clones.

## Source-of-truth model

- `portable-codex-starter/` is the canonical source of truth for the portable pack.
- The starter is intended to be self-contained and copyable into other repositories without depending on OMX source-repo overlays.
- Full pack installability is enforced with `npm run verify:kit` from inside `portable-codex-starter/`.
