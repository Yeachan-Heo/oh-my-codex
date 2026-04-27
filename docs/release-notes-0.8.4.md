# oh-my-codex v0.8.4

Released: **2026-03-06**

This is a **setup-flow patch release** focused on making `omx setup` refresh behavior safer, more predictable, and easier to rerun.

---

## TL;DR

- `omx setup` now refreshes managed OMX artifacts by default instead of leaving stale generated content behind.
- Managed refresh paths now preserve backups where applicable before overwriting files.
- Setup prompts before upgrading managed Codex model references from `gpt-5.3-codex` to `gpt-5.5`.
- Added deeper refresh/idempotency regression coverage for setup and config generation paths.
- Includes small release-validation hardening: watcher shutdown cleanup stability and dead-code cleanup surfaced by the strict no-unused gate.

---

## What changed

### 1) Managed OMX artifacts refresh by default

Setup now treats managed OMX artifacts as refreshable outputs rather than one-time drops. Re-running `omx setup` updates shipped artifacts more consistently, helping existing installations stay aligned with current templates and generated assets.

**Why this matters:**
- reduces stale generated files after upgrades
- makes repeat setup runs safer and more useful
- improves consistency between fresh installs and refreshed installs

### 2) Refresh paths preserve backups before overwriting

When setup replaces managed artifacts, it now does so with stronger backup behavior where applicable.

**Why this matters:**
- lowers risk when refreshing existing local OMX-managed files
- gives users a clearer recovery path if they need to inspect prior state
- makes setup automation less destructive

### 3) Setup now prompts before model upgrade rewrites

When managed configuration refreshes would upgrade Codex model references from `gpt-5.3-codex` to `gpt-5.5`, setup now asks before making that change.

**Why this matters:**
- avoids surprising model upgrades during routine refreshes
- preserves user trust when setup wants to modify existing config
- keeps managed defaults modern without forcing silent rewrites

### 4) Regression coverage expanded for refresh and idempotency

This release adds/extends tests and validation hardening around:
- setup refresh behavior
- scoped overwrite handling
- uninstall compatibility during setup-managed refreshes
- config generator idempotency and notify-aware generation flows
- watcher shutdown/cleanup synchronization during streaming fallback tests

---

## Included commits

- `fed035b` — feat(setup): refresh managed OMX artifacts by default with backups
- `6aa577d` — feat(setup): prompt before upgrading gpt-5.3-codex to gpt-5.5

---

## Verification summary

Release verification evidence is recorded in `docs/qa/release-readiness-0.8.4.md`.

Planned release gates:
- `npm run build`
- `npm test`
- `npm run check:no-unused`
- CLI smoke checks (`--help`, `version`, `doctor`, `setup --dry-run`)

---

Thanks for using **oh-my-codex**. If anything regresses, please open an issue with reproduction steps, logs, and your CLI/runtime details.
