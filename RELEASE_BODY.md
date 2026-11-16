# oh-my-codex v0.22.10

## Summary

This patch release ships updated ralplan skill guidance aligned with the warn-and-skip runtime policy for unavailable custom gates. The ralplan skill documentation now correctly reflects that custom gates unavailable in the host environment are warned about and skipped at runtime, not treated as error conditions. Skill examples and workflow paths no longer reference or require missing custom gates, fixing the documentation inconsistency reported in #4096.

## Changed

- **ALIGN RALPLAN CUSTOM-GATE GUIDANCE WITH WARN-AND-SKIP POLICY (#4097):** Ralplan skill guidance now documents that unavailable custom gates are warned about and skipped at runtime. Skill examples and expected workflow paths are updated to remove references to missing custom gates, aligning skill documentation with actual runtime behavior. Fixes #4096.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.10`.

## Verification

- Full CI on dev candidate (candidate details recorded in [release readiness](docs/qa/release-readiness-0.22.10.md)).
- PR #4097 CI passed on merged head.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) for contributing to this release.

**Full Changelog**: [`v0.22.9...v0.22.10`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.9...v0.22.10)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
