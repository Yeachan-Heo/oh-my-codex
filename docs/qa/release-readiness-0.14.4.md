# Release Readiness Verdict - 0.14.4

Date: 2026-04-24
Target version: **0.14.4**
Base: `v0.14.3`
Candidate branch: `hotrelease/0.14.4-gpt55`

## Scope

`0.14.4` promotes the default frontier lane from `gpt-5.4` to `gpt-5.5` while preserving the exact `gpt-5.4-mini` seam and the `gpt-5.3-codex-spark` spark lane. The release also aligns setup/config messaging, templates, tests, and package metadata around that model contract.

## Changed execution paths reviewed

- `src/config/*` — default frontier model contract plus generator/setup regression coverage.
- `src/cli/*` — Codex agent defaults, setup-refresh expectations, uninstall/doctor fixtures, and explore fallback messaging.
- `src/team/*`, `src/hooks/*`, `src/agents/*` — runtime/prompt-contract expectations that display or validate the frontier default.
- `crates/omx-explore/*` — explore fallback default model behavior.
- `README.md`, `docs/*.html`, `docs/prompt-guidance-contract.md`, `templates/AGENTS.md` — user-facing and generated guidance aligned to the new frontier default while preserving mini/spark lanes.
- Release collateral — `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `CHANGELOG.md`, `RELEASE_BODY.md`, and these release notes/readiness docs aligned to `0.14.4`.

## Verification evidence

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript build | `npm run build` | PASS |
| Targeted model/default suites | `node --test dist/agents/__tests__/definitions.test.js dist/agents/__tests__/native-config.test.js dist/team/__tests__/model-contract.test.js dist/utils/__tests__/agents-model-table.test.js dist/cli/__tests__/setup-agents-overwrite.test.js` | PASS |
| Targeted executor launch defaults | `node --test --test-name-pattern=... dist/team/__tests__/runtime.test.js` | PASS |
| Earlier pre-interruption gates | `npm run lint`, `npm run check:no-unused`, `cargo test --workspace` | PASS |

## Known limits

- External push, GitHub PR/merge, and tag publication depend on local credentials/network availability.
- CI merge gating still depends on the opened PR reaching green on GitHub.

## Verdict

Release **0.14.4** is **ready for PR/CI verification and release cut** once the verification gates above pass on this branch and GitHub CI is green. It is safe to merge the hotrelease into `main`, cherry-pick the bump onto `dev`, and create tag `v0.14.4` from merged `main`.
