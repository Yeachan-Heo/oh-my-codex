# oh-my-codex v0.22.15

## Summary

This patch release improves vision model guidance by requiring reliable viewport evidence for CSS advice, ensuring more accurate styling recommendations for responsive components.

## Improved

- **REQUIRE RELIABLE VIEWPORT EVIDENCE FOR CSS ADVICE (#4123):** Vision model styling recommendations now require reliable viewport evidence, preventing CSS advice on components when viewport context cannot be verified. This ensures recommendations reflect the actual rendering environment and reduces false-positive style suggestions.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.15`.

## Verification

- Full CI on dev candidate (candidate details recorded in [release readiness](docs/qa/release-readiness-0.22.15.md)).
- Dev CI run 44987440579 passed all checks.

## Contributors

Thanks to [@ev78394](https://github.com/ev78394) for contributing to this release.

**Full Changelog**: [`v0.22.14...v0.22.15`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.14...v0.22.15)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
