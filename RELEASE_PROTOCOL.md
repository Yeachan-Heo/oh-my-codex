# Release Protocol

This protocol is mandatory for every `oh-my-codex` release. It exists to prevent release notes, changelogs, and GitHub release bodies from understating the actual shipped compare range.

## 1. Freeze the release range before writing notes

1. Identify the previous released tag and candidate ref.
   - Example: `PREV=v0.16.1`, `NEXT=v0.16.2`, `CANDIDATE=dev`.
2. Verify the previous tag is an ancestor of the candidate.
   - `git merge-base --is-ancestor "$PREV" "$CANDIDATE"`
3. Generate the commit and PR inventory from the exact compare range.
   - `git log --oneline --decorate "$PREV..$CANDIDATE"`
   - `git log --format='%h %s' "$PREV..$CANDIDATE" | grep -Eo '#[0-9]+' | sort -u`
   - `gh pr list --state merged --limit 100 --json number,title,mergedAt,author,url,mergeCommit`
4. Cross-check that every merge commit / PR in the compare range is represented in release notes or intentionally excluded as internal-only.

## 2. Write release notes from evidence, not memory

Release collateral must be based on the compare-range inventory, not on the last blocker fixed during release review.

Required files:

- `CHANGELOG.md`
- `docs/release-notes-<version>.md`
- `docs/qa/release-readiness-<version>.md`
- `RELEASE_BODY.md`

Required release-note sections:

- Highlights / major user-visible changes
- Fixes / compatibility notes
- Merged PR inventory with PR numbers and links
- Validation evidence
- Full changelog compare link

If a release includes major workflow changes (for example `$ultragoal`, `$ralph`, `$team`, wiki, setup, native hooks, MCP state, or Codex goal-mode behavior), those changes must appear in the Highlights section even if the final pre-ship blocker was unrelated.

## 3. Validate the GitHub release body before tagging

`RELEASE_BODY.md` is a template consumed by `dist/scripts/generate-release-body.js`.

Before pushing a release tag, run:

```sh
node dist/scripts/generate-release-body.js \
  --template RELEASE_BODY.md \
  --out /tmp/RELEASE_BODY.generated.md \
  --current-tag "$NEXT" \
  --previous-tag "$PREV" \
  --repo Yeachan-Heo/oh-my-codex
```

Hard requirements:

- The template contains `## Contributors`.
- The generated body still includes all major compare-range changes.
- The generated body includes the correct `**Full Changelog**` line.
- The contributors section is reviewed against the merged PR authors and matches the prior release-train sentence format; do not blindly accept shortlog-only generated names when release-prep commits distort the author list.

## 4. Release-readiness gate

Before merging to `main` or tagging:

1. Local gates appropriate to the touched surface pass.
2. `dev` CI is green for the candidate commit.
3. `docs/qa/release-readiness-<version>.md` records:
   - compare range
   - PR inventory
   - local gates
   - CI run IDs
   - known gaps
4. The release notes are reviewed against `git log "$PREV..$CANDIDATE"`, not just against the latest fix.

## 5. Publish sequence

1. Merge the verified candidate to `main`.
2. Wait for `main` CI green.
3. Create/push the annotated tag only after release collateral is complete.
4. Wait for the tag-triggered release workflow to pass.
5. Verify:
   - GitHub release exists and is non-draft/non-prerelease.
   - Native assets and manifest are attached.
   - `npm view oh-my-codex version` returns the release version.
6. Fast-forward `dev` to the shipped `main` commit and wait for final shipped-commit `dev` CI green.
7. Immediately bump `dev` package/plugin/Cargo metadata to the next development base version (for example, after publishing `v0.18.17`, commit `0.18.18` on `dev`) so dev installs display as `v<next>-dev-<revision>` instead of sharing the just-published stable base.

## 6. Post-publish corrections

If release notes are found incomplete after npm publish:

1. Do **not** move a published npm provenance tag unless the release artifact itself is invalid and maintainers explicitly choose an emergency retag.
2. Commit corrected release collateral to `dev`, then promote it to `main` through the normal CI path.
3. Regenerate the GitHub release body from the corrected `RELEASE_BODY.md`.
4. Update the existing GitHub release body with `gh release edit "$NEXT" --notes-file /tmp/RELEASE_BODY.generated.md`.
5. Record the correction in `docs/qa/release-readiness-<version>.md`.

## 7. Stop condition

A release is complete only when all are true:

- `main` and the release tag point to the intended shipped commit, and `dev` either still points to that shipped commit or contains only documented post-publish corrections plus the next development base-version bump.
- GitHub release workflow is green.
- npm shows the expected version.
- GitHub release body accurately summarizes the full compare range.
- Release-readiness evidence includes CI and publication proof.
