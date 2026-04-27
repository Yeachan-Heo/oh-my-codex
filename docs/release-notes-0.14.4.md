# Release notes — 0.14.4

## Summary

`0.14.4` is a patch release after `0.14.3` that promotes the default frontier lane from `gpt-5.4` to `gpt-5.5` while intentionally preserving the exact `gpt-5.4-mini` standard/mini seam and the `gpt-5.3-codex-spark` spark lane.

## Highlights

- Runtime defaults, Codex agent defaults, and `omx explore` fallback behavior now resolve the frontier lane to `gpt-5.5`. Setup and setup and executor worker reasoning defaults now use medium instead of high.
- Setup/config seeding docs and regression coverage now describe `gpt-5.5` with the existing `model_context_window = 250000` and `model_auto_compact_token_limit = 200000` recommendations.
- Exact-match `gpt-5.4-mini` behavior remains unchanged.
- Spark defaults remain on `gpt-5.3-codex-spark`.
- Release/package metadata is aligned for the `0.14.4` cut.

## Compatibility

- No user migration is required.
- Existing `gpt-5.4-mini` and `gpt-5.3-codex-spark` overrides keep their current semantics.
- Fresh/default frontier-managed config paths now prefer `gpt-5.5`.

## Verification

- `npm run build` ✅
- Targeted Node suites for model/default changes ✅
- `npm run lint`, `npm run check:no-unused`, and `cargo test --workspace` passed earlier on this branch ✅
- Full `npm test` was intentionally not rerun after the final fast-path executor reasoning tweak.

Release verification evidence is recorded in `docs/qa/release-readiness-0.14.4.md`.
