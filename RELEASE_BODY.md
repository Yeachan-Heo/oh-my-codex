# oh-my-codex v0.21.48

## Summary

This patch release drops role-based reasoning-effort defaults from seven role prompts, ensuring Vision stays extraction-only unless reassessment is justified.

## Fixed

- **ROLE-BASED REASONING-EFFORT DEFAULTS (#4020, #4021):** Seven role prompts (analyst, api-reviewer, architect, code-reviewer, code-simplifier, critic, and designer) included hardcoded reasoning-effort recommendations that read as unconditional requests for commentary. These recommendations are now removed; Vision prompt is updated to make effort recommendations conditional: 'If reassessment is justified from task demands, remaining uncertainty, available proof, and resource limits, recommend a supported reasoning effort and briefly compare plausible alternatives without a role-based default; otherwise preserve extraction-only output.' This aligns all outputs with their documented success criteria.

## Compatibility

No breaking API changes. Release-coupled metadata was synchronized to `0.21.48` on dev by #4017. `package.json`, both root `package-lock.json` version entries, the Cargo workspace and six workspace crates, and plugin metadata all report `0.21.48` at the pinned source.

## Verification

- `npm ci` — passed; 172 packages installed and lifecycle hooks completed.
- `npm run build` — passed.
- `npm test` — passed on the full test run: runtime build, all Node test files, generated catalog check, and prompt-inventory check completed.
- `npm run lint` — passed across 900 files. Biome emitted the existing `linter.rules.recommended` deprecation notice; no lint fixes were applied.

## Contributors

Thanks to @ev78394 for dropping the unconditional reasoning-effort defaults (#4021).

**Full Changelog**: [`v0.21.47...v0.21.48`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.47...v0.21.48)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
