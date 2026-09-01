# Release inventory — v0.21.1..dev@04533ebf

- Previous tag: `v0.21.1` = `8513abf70609061770a97100ef8964c8ebb40700`.
- Candidate: `dev@04533ebfc887643586e37180ec3270473948115a`.
- Range: 11 commits, 29 files, +1,245/−10.
- Merge commits: 5 (three PR merges plus release/main-to-dev reconciliation merges).
- Referenced PRs: #3599, #3601, #3602.
- Contributors from git shortlog: Bellman, NagyVikt, gaebal-gajae, and Dendroculus.

## Included work

- #3599 — Indonesian README translation and synchronized localized navigation.
- #3601 — optional bounded GitGuardex finish progress in the HUD.
- #3602 — bounded `omx-runtime` hydration for global install/reinstall and immediate/deferred updates.

## Reproduction

```sh
git rev-list --count v0.21.1..04533ebfc887643586e37180ec3270473948115a
git diff --shortstat v0.21.1..04533ebfc887643586e37180ec3270473948115a
git log --pretty='%s' v0.21.1..04533ebfc887643586e37180ec3270473948115a | grep -oE '#[0-9]+' | sort -u
```
