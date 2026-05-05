# Tasks

- [x] 1.1 Add/adjust tests
  - Added e2e coverage for help visibility, mode persistence, and `cursor apply --run` invocation in `src/cli/__tests__/cursor-mode-e2e.test.ts`.
  - verify: `npm run build && node --test dist/cli/__tests__/cursor-mode-e2e.test.js`
- [x] 1.2 Implement minimal change
  - Added top-level help entries for `omx cursor` and `omx mode` in `src/cli/index.ts`.
  - verify: `npm run build && node dist/cli/omx.js --help`
- [x] 1.3 Sync contract/doc
  - Replaced template placeholders in `proposal.md` and `specs/spec.md` with concrete In_Scope/Out_Of_Scope and NFR-aligned scenarios.
  - verify: `bash scripts/check-drift.sh feature-cursor-e2e`
- [ ] 1.4 Final verification
  - verify: `npm run build && npm run lint && node --test dist/cli/__tests__/cursor-mode-e2e.test.js && bash scripts/check-drift.sh feature-cursor-e2e`
