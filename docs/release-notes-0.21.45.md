# oh-my-codex 0.21.45

`0.21.45` fixes a false unsafe-trust-migration report for unchanged foreign Codex hook groups whose matcher is the empty string (#3984).

## Fixed

- **EMPTY FOREIGN HOOK MATCHER TRUST (#3985, fixes #3984):** `foreignHookTrustHash` now includes `matcher` whenever it is a string, including `""`. The previous truthiness check omitted an explicitly empty matcher from the identity input, so the computed trust hash could differ from the stored Codex trust hash and `omx doctor` could report `unsafe_managed_removal` for a hook group that had not changed.
- Regression coverage exercises a foreign hook group with `matcher: ""`, confirms removal planning succeeds, and verifies its expected trust hash and coordinate migration.

The separately reported SessionEnd outlier is not addressed by this change. No broader fix for unrelated hook-trust issues is claimed.

## Compatibility

No breaking API changes. Release-coupled metadata was already synchronized to `0.21.45` on dev by #3982, so the release branch does not bump those values again. `package.json`, both root `package-lock.json` version entries, the Cargo workspace and six workspace crates, and plugin metadata all report `0.21.45` at the pinned source.

## Included scope

The pinned source is `0057f272db97454afa8ccf3320ed590175016b0a`. The only product change since `v0.21.44` is #3985; other history in the source ancestry is release-train synchronization or changes already present in the previous release. The source diff is limited to `src/config/codex-hooks.ts` and its regression test in `src/config/__tests__/codex-hooks.test.ts` (36 insertions, 1 deletion).

**Full Changelog**: [`v0.21.44...v0.21.45`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.44...v0.21.45)

## Validation

Local release gates and release-pipeline evidence are recorded in [release readiness](qa/release-readiness-0.21.45.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
