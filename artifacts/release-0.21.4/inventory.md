# Release inventory — v0.21.3..dev@b08eceee

- Previous tag: `v0.21.3` = `2da36489cfa07ef1df802f01865e7d959d36f236`.
- Frozen candidate: `dev@b08eceeecc7a7379f041ceca51260f073d8a95bb`.
- Range: 3 commits, 35 files, +364/−195.
- Merged PRs: #3615, #3618, #3622.
- Commit authors from git shortlog: Bellman (`@Yeachan-Heo`) and `@ev78394`.

## Exact commit inventory

- `b08eceeecc7a7379f041ceca51260f073d8a95bb` — #3622 — default OMX leaders, specialists, fast agents, low-complexity workers, Team children, planning/research roles, and SparkShell summaries to `gpt-6-astra` while preserving explicit model selections, profiles, overrides, providers, and existing reasoning effort.
- `c4cb57e22e4f0845cbab3c910656de9f4ab4b47d` — #3618 — align the generated agent catalog documentation with the packaged active/internal role catalog and current `$deep-interview` → `$ralplan` → `$ultragoal` workflow guidance; document merged and deprecated role replacements.
- `4618b5df412c6cc9dd7b092ed6f8760fd32e8f1d` — #3615 — advance synchronized package/plugin/Cargo development metadata from the shipped 0.21.3 base to 0.21.4. This is release-train metadata, not a separate product headline.

## Scope exclusions and known gap

- Issue #3623 is open, separately owned, and has no merged PR in this frozen range. It confirms a doctor/setup diagnostic and configuration compatibility bug around Codex's removed `plugin_hooks` feature flag on Codex CLI 0.153.4.
- #3623 does not demonstrate a runtime hook outage: native `hooks/list` recognized the installed plugin hooks. The 0.21.4 release records this as an unresolved known gap and does not claim the issue fixed or shipped.
- Commits merged to `dev` after `b08eceeecc7a7379f041ceca51260f073d8a95bb` are outside this release candidate unless the release range is explicitly re-frozen and all collateral and verification are repeated.

## Reproduction

```sh
git merge-base --is-ancestor v0.21.3 b08eceeecc7a7379f041ceca51260f073d8a95bb
git rev-list --count v0.21.3..b08eceeecc7a7379f041ceca51260f073d8a95bb
git diff --shortstat v0.21.3..b08eceeecc7a7379f041ceca51260f073d8a95bb
git log --format='%H %an <%ae> %s' v0.21.3..b08eceeecc7a7379f041ceca51260f073d8a95bb
```
