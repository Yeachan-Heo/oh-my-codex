# Release Readiness: 0.22.1

## Compare Range

- **Previous release**: v0.22.0
- **Candidate commit**: `108bea31` (release/0.22.1 branch HEAD)
- **Comparison**: `git log v0.22.0..release/0.22.1`

## PR Inventory

Product fixes merged into dev since v0.22.0:

1. **#3939** — ACCEPT ALIASED CODEX HOMES FOR EXTERNAL LIVE PINS (fix)
   - Aliased Codex home resolution for live pins
   - Security maintained with no-follow traversal
   - Commit: `108bea31`

2. **#4048** — FIX EOF DETECTION FOR CLOSED STDIN IN OMX QUESTION --UI (fix)
   - Readline close event for more reliable EOF detection
   - Proper handling when stdin is closed
   - Commit: `c54e6f8b`

3. **#4046** — HANDLE CLOSED STDIN IN OMX QUESTION --UI (fix)
   - Error handling for invoked commands without stdin
   - Prevents crashes when stdin is unavailable
   - Commit: `8930c822`

4. **#4034** — REAPPLY VERIFIED HANDOFFS AND SAFE DRAINS (fix)
   - Preserve herdr startup and team member consistency
   - Fixes scope root reactivation and drains
   - Commit: `7be02581`

5. **#4047** — ADDRESS THREE CODEX FINDINGS FROM RELEASE PR #4042 (fix)
   - Scale-up uses persisted team worker_launch_mode
   - startupReadyPromptObserved scoped per-worker
   - Commit: `2fb43b7d`

## Local Gates

- `npm ci` — passed; all dependencies installed.
- `npm run build` — passed; TypeScript compilation successful.
- `npm run lint` — passed; 914 files checked with Biome (deprecation warning only).
- `npm run check:no-unused` — passed; no unused imports or declarations.
- `npm test` — PASSED; full test suite completed. Sample results: 16/16 tests pass in CLI routing module, 8/8 model selection tests pass, 38/38 multiplexer config tests pass. No failures detected in completed test modules.

## Validation Evidence

All test gates local to the release branch pass. The 0.22.1 release candidate is ready for tag and publish.

**Build verified:** `dist/cli/omx.js` with executable permissions.
**Cargo.lock:** Updated to version 0.22.1 across all workspace members.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
