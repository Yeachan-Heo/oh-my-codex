# oh-my-codex 0.20.1 release notes

Release date: 2026-07-12

`0.20.1` is a patch release covering the exact range `v0.20.0..9eadab9f191103177fb3eac1b237188ada1f503c`. It contains seven bug-fix PRs and two prior-release collateral corrections.

## Fixes

- **CRLF generated AGENTS markers** — generated `AGENTS.md` marker insertion preserves CRLF line endings (#3107).
- **Ralplan Markdown drafts** — the native planning-write boundary allows normalized direct-child Markdown artifacts in `.omx/drafts/` while retaining fail-closed protection for other targets (#3110).
- **Configuration default seeding** — fresh setup no longer forces legacy multi-agent or context-window defaults, preserving user-owned configuration and native role routing (#3111, #3115).
- **Stop response protocol** — Stop responses remain schema-safe by omitting unsupported top-level fields (#3114).
- **Delegated child provenance** — the Conductor guard recognizes trusted delegated collaboration children while retaining leader and planning-boundary protections (#3117; issue #3116).
- **Native delegation and quoted Bash targets** — incomplete capability inventories are handled without unsafe delegation probes, and redirect syntax inside quoted Bash arguments is not misparsed as a write target (#3120; issue #3119).

## Range inventory

| Commit | Classification | Summary |
|---|---|---|
| `f644d2cd3ae98587942aa94f0030f083ea0bb10f` | Direct commit; no PR; prior-release collateral correction | Corrected 0.20.0 collateral to cover its full compare range. |
| `5d43a5bf6f008de17f9425bee4495c457c60b96a` | Direct commit; no PR; prior-release collateral correction | Clarified that capabilities preflight is a manual command. |
| `9ea0181820186e7ac14f2ba60c130af3dfb5ce26` | PR #3107 | Fixed CRLF generated AGENTS marker insertion. |
| `0f38ebecda8e39c6d0346574364185ff45c29f8d` | PR #3110 | Fixed Ralplan Markdown draft artifact writes. |
| `05262a1cb27429c72764dc4ba0b3c96a2e987fa3` | PR #3111 | Stopped seeding legacy multi-agent configuration. |
| `754716f179ee69f58a3df1803ff6bdd5688fba9f` | PR #3114 | Kept Stop responses schema-safe. |
| `5fa4f43585ac539bb2df31a8488c4373594d079a` | PR #3115 | Stopped seeding legacy context defaults. |
| `d4c605fc44b2ce2e87e650630768449f05bd1492` | PR #3117; issue #3116 | Trusted delegated collaboration-child provenance under the Conductor guard. |
| `9eadab9f191103177fb3eac1b237188ada1f503c` | PR #3120; issue #3119 | Detected native delegation presence and fixed quoted Bash write-target parsing. |

Exactly seven PRs are included: #3107, #3110, #3111, #3114, #3115, #3117, and #3120. #3116 and #3119 are issues, not PRs. The first two commits are documentation-only corrections carried forward from the previous release and are not product-fix headlines.

## Compatibility

This is a patch release with no intentional breaking CLI or package-layout changes.

## Validation status

Release readiness is static and pre-tag. `docs/qa/release-readiness-0.20.1.md` defines the required local gates, exception contract, evidence schema, and pending external CI/publication proof. No test result, review result, CI run, tag, GitHub release, or npm publication is asserted by these notes.

## Full changelog

[`v0.20.0...v0.20.1`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.0...v0.20.1)
