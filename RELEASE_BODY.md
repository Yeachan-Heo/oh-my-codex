# oh-my-codex 0.20.1

`0.20.1` is a patch release for the reliability fixes in `v0.20.0..9eadab9f191103177fb3eac1b237188ada1f503c`.

## Highlights

- CRLF-safe generated `AGENTS.md` marker insertion (#3107).
- Ralplan can write normalized direct-child Markdown draft artifacts under `.omx/drafts/` without relaxing the native planning-write boundary (#3110).
- Fresh setup stops seeding legacy multi-agent and context-window defaults, leaving user-owned configuration and native role routing intact (#3111, #3115).
- Stop hook responses remain schema-safe (#3114).
- Conductor execution recognizes trusted delegated collaboration-child provenance while protecting leader and planning-boundary cases (#3117; issue #3116).
- Native delegation detection handles incomplete capability inventories safely, and quoted Bash argument values no longer misparse as write targets (#3120; issue #3119).

## Merged PRs since v0.20.0

#3107 (CRLF generated AGENTS marker insertion), #3110 (Ralplan Markdown draft artifact writes), #3111 (legacy multi-agent default seeding), #3114 (schema-safe Stop responses), #3115 (legacy context-default seeding), #3117 (delegated collaboration-child provenance; issue #3116), #3120 (native delegation detection and quoted Bash target parsing; issue #3119).

## Prior-release collateral corrections

`f644d2cd3ae98587942aa94f0030f083ea0bb10f` corrected the 0.20.0 collateral compare coverage, and `5d43a5bf6f008de17f9425bee4495c457c60b96a` clarified that capabilities preflight is a manual command. These direct commits are prior-release collateral corrections, not 0.20.1 product headlines.

## Compatibility

Patch release with no intentional breaking CLI or package-layout changes.

## Validation

The pre-tag command gates, evidence schema, and pending external CI/publication evidence are declared in `docs/qa/release-readiness-0.20.1.md`. No local gate, review, CI, tag, or publication result is asserted here.

## Contributors

Thanks to the contributors who made this release possible.

**Full Changelog**: [`v0.20.0...v0.20.1`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.0...v0.20.1)
