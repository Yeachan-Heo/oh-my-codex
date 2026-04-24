# oh-my-codex v0.14.4

## Summary

`0.14.4` is a patch release after `v0.14.3` that promotes the default frontier lane from `gpt-5.4` to `gpt-5.5` while intentionally preserving the exact `gpt-5.4-mini` standard/mini seam and the `gpt-5.3-codex-spark` spark lane. The release aligns runtime defaults, setup/config seeding, docs, templates, and regression coverage around that model contract.

## Changed

- **Default frontier model is now `gpt-5.5`** — runtime defaults, Codex agent defaults, and `omx explore` fallback handling now point at `gpt-5.5`.
- **Setup/config guidance stays aligned with the new frontier default** — config generators, setup-refresh coverage, README/site docs, and managed-config guidance now describe `gpt-5.5` seeding and the same `250000 / 200000` context recommendations.
- **Mini and spark lanes remain exact** — the `gpt-5.4-mini` seam and `gpt-5.3-codex-spark` low-complexity lane remain unchanged, with tests/docs preserving the exact-match contract.
- **Release metadata is aligned to `0.14.4`** — package/Cargo metadata plus release collateral are prepared for the `0.14.4` cut.

## Verification

- `npm run build` ✅
- Targeted Node suites for model/default changes ✅
- `npm run lint`, `npm run check:no-unused`, and `cargo test --workspace` passed earlier on this branch ✅
- Full `npm test` was intentionally not rerun after the final fast-path executor reasoning tweak.

## Upgrade notes

- Existing users do not need to change mini or spark overrides.
- Fresh/default frontier paths will now seed or recommend `gpt-5.5` where OMX owns that configuration.

## Contributors

Thanks to the contributors who made this release possible.

**Full Changelog**: [`v0.14.3...v0.14.4`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.14.3...v0.14.4)
