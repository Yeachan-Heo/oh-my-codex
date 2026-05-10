# Release Readiness Verdict - 0.16.3

Target version: **0.16.3**
Date: 2026-05-09
Compare link: [`v0.16.2...v0.16.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.16.2...v0.16.3)
Release: https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.16.3

## Verdict

**PREPARED FOR RELEASE.** `0.16.3` is the release candidate for the post-`0.16.2` native-hook/setup/runtime hardening train. Publication evidence must be filled after CI/tag workflows complete.

## Release surface

- Codex hook setup/config: supported `[features].hooks = true`, runtime hook trust placement, dedupe, Windows command generation, and native compact hook JSON validity.
- Setup/uninstall ownership: user notify preservation, user hook enablement preservation, managed notify detection hardening, and project-scope runtime mirror boundaries.
- Team/planning/runtime: approved handoff context, ready context-pack role refs, launch signature preservation, role-agnostic hints, startup-evidence state-root isolation, and local planning artifact reads.
- Workflow lifecycle: stale Ralph resume prevention and blocked autoresearch Stop reconciliation.

## Verification evidence

| Gate | Result |
| --- | --- |
| Official Codex docs check | PASS — lifecycle hooks use `[features].hooks = true`. |
| Local blocker suite | PASS — `npm run build`, `npm run lint`, `npm run check:no-unused`, targeted setup/config/uninstall/hook/Team Node tests, and `git diff --check`. |
| Release body generation | PASS — generated from `RELEASE_BODY.md` with `v0.16.2...v0.16.3` compare inputs before tagging. |
| Dev CI | PENDING — verify after pushing the release-prep commit. |
| Main CI | PENDING — verify after promotion. |
| Release workflow | PENDING — verify after pushing tag `v0.16.3`. |
| GitHub release | PENDING — verify non-draft/non-prerelease release and native assets. |
| npm | PENDING — verify `npm view oh-my-codex version` returns `0.16.3`. |

## Notes

- Local npm credentials are not available in this environment; publication is expected to run through the repository release workflow/trusted publishing path after the signed/annotated tag is pushed.
- If post-publish evidence is committed after the tag, document the deliberate docs-only divergence per `RELEASE_PROTOCOL.md`.
