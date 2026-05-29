# Repository Guidelines

## Project Structure & Module Organization

This repository is a multi-agent orchestration layer for Codex CLI. TypeScript source lives in `src/`, with feature modules such as `src/hud`, `src/notifications`, `src/hooks`, `src/scripts`, and `src/sidecar`. Tests are colocated in `__tests__` directories and compile to matching paths under `dist/`. Rust workspace crates live in `crates/` (`omx-api`, `omx-runtime`, `omx-sparkshell`, and related packages). User-facing prompts, skills, plugin assets, and templates are in `prompts/`, `skills/`, `plugins/`, and `templates/`. Documentation and release process files are in `docs/`, `CHANGELOG.md`, and `RELEASE_PROTOCOL.md`.

## Build, Test, and Development Commands

- `npm install`: install Node dependencies. Requires Node.js >= 20.
- `npm run dev`: run TypeScript in watch mode.
- `npm run build`: clean and compile TypeScript to `dist/`, then make the CLI executable.
- `npm test`: full local verification, including build, native-agent checks, plugin-bundle checks, Node tests, and catalog doc validation.
- `npm run lint`: run Biome linting over `src`.
- `npm run check:no-unused`: run the stricter unused-code TypeScript config.
- `cargo test --workspace`: run Rust crate tests.
- `npm run coverage:team-critical`: enforce coverage gates for critical team/state paths.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules and NodeNext resolution. Keep source files focused by feature area and prefer named exports for shared helpers. Follow existing naming: kebab-case filenames such as `session-registry.ts`, PascalCase types/interfaces where appropriate, and `*.test.ts` for tests. Biome is the configured linter; avoid unrelated formatting churn. Rust crates use edition 2021 and standard `cargo fmt` style.

## Testing Guidelines

Add or update colocated tests in the relevant `__tests__` directory. TypeScript tests use Node's built-in test runner after compilation, generally run through `npm test` or targeted commands such as `node --test dist/hud/__tests__/render.test.js`. For Rust behavior, add tests under each crate's `tests/` directory or module tests and run `cargo test --workspace`.

## Commit & Pull Request Guidelines

History favors concise, intent-first messages, often with prefixes like `feat:`, `fix:`, `docs:`, and `chore:`. Branch normal work from `dev` and target PRs to `dev` unless maintainers direct otherwise. PRs should describe scope, link issues when relevant, list verification commands, include screenshots for visible UI/docs changes, and note documentation updates or explicitly state `Document-refresh: not-needed | <reason>` when applicable.

## Agent-Specific Notes

Before changing prompt surfaces such as `templates/AGENTS.md`, `prompts/*.md`, or generated developer instructions, read `docs/prompt-guidance-contract.md`. Do not edit generated `dist/` output directly; change source and rebuild.

## OMX Surface Compatibility

This contributor guide is intentionally separate from the generated OMX orchestration brain in `templates/AGENTS.md`, but checked-in AGENTS surfaces should still preserve key routing language when present. The `ouroboros` path maps to the Socratic deep interview workflow. Keyword registry row: `analyze` / `investigate` -> `$analyze` for read-only deep analysis with ranked synthesis, explicit confidence, and concrete file references. In Codex App or outside-tmux contexts, do not present tmux-only Team runtime paths as directly available; launch OMX CLI from shell first because Team requires CLI runtime support.
