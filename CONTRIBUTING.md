# Contributing to oh-my-codex

Thanks for contributing.

## Development setup

- Node.js >= 20
- npm

```bash
npm install
npm run build
npm test
```

For local CLI testing:

```bash
npm link
omx setup
omx doctor
```

## Project structure

- `src/` -- TypeScript source (CLI, config, agents, MCP servers, hooks, modes, team, verification)
- `prompts/` -- 30 agent prompt markdown files (installed to `~/.codex/prompts/`)
- `skills/` -- 39 skill directories with `SKILL.md` (installed to `~/.agents/skills/`)
- `templates/` -- `AGENTS.md` orchestration brain template

### Adding a new agent prompt

1. Create `prompts/my-agent.md` with the agent's system prompt
2. Run `omx setup --force` to install it to `~/.codex/prompts/`
3. Use `/prompts:my-agent` in Codex CLI

### Adding a new skill

1. Create `skills/my-skill/SKILL.md` with the skill workflow
2. Run `omx setup --force` to install it to `~/.agents/skills/`
3. Use `$my-skill` in Codex CLI

## Workflow

1. Create a branch from `main`.
2. Make focused changes.
3. Run build and tests locally.
4. Open a pull request using the provided template.

## Commit style

Use concise, intent-first commit messages. Existing history uses prefixes like:

- `feat:`
- `fix:`
- `docs:`
- `chore:`

Example:

```text
docs: clarify setup steps for Codex CLI users
```

## Pull request checklist

- [ ] Scope is focused and clearly described
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] Documentation updated when behavior changed
- [ ] No unrelated formatting/refactor churn

## Reporting issues

Use the GitHub issue templates for bug reports and feature requests, including reproduction steps and expected behavior.
