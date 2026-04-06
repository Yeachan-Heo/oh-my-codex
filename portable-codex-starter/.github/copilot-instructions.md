# Repository-wide Copilot instructions

This repository is using the Portable Codex Starter personal-use pack derived from `oh-my-codex`. Preserve Codex as the main execution engine and treat this repo as a repo-local agent workspace, not as a generic app project.

## Ground work in repo contracts

- Read `AGENTS.md` before any non-trivial change. It is the primary operating contract for the repository.
- Treat `.codex/agents/`, `.agents/skills/`, and `.github/` automation files as intentional steering layers, not as disposable scaffolding.
- If you edit `AGENTS.md`, preserve its structure and keep the instructions self-sufficient for future reuse.

## Repo shape

- `AGENTS.md` sets Codex behavior for the repository.
- `.codex/agents/` contains Codex-native specialist roles.
- `.agents/skills/` contains portable skill workflows.
- `.github/skills/` contains GitHub Copilot skill playbooks for repeated operational procedures.
- `.devcontainer/` configures GitHub Codespaces startup.
- `.github/copilot-instructions.md`, `.github/instructions/`, and `.github/agents/` shape GitHub Copilot behavior.
- `.github/hooks/` and `.github/workflows/copilot-setup-steps.yml` are automation-sensitive.

## Change discipline

- Keep changes narrow and reversible.
- Prefer existing patterns and repo-local assets over new dependencies.
- Workflow, hook, and environment files are security-sensitive; default to least privilege and deterministic behavior.
- If you change the starter pack behavior, keep `README.md` focused on quickstart and put longer operational detail in `docs/`.
