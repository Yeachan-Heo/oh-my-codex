# Bloat audit — skills + agents (omx)

Generated 2026-05-23. Companion to `inventory.md`. Each entry is classified into one of:

- **KEEP-AS-IS** — actively used, fits cleanly with neighbors.
- **CONSOLIDATE** — duplicated or redundant with another surface; merge into the canonical entry.
- **STREAMLINE** — useful but bloated; cut boilerplate or dead branches.
- **DEPRECATE** — not used anywhere or superseded; remove from disk + manifest after a grace cycle.
- **AMBIGUOUS — NEEDS OWNER DECISION** — could go either way; flagged for owner.

Evidence per entry: catalog status (`src/catalog/manifest.json`), reference count (`rg -l -F` outside the entry's own directory), and where applicable LOC + most-recent commit. Risk level is the auditor's estimate of what could break if the entry were removed *as-is*. The full reference set per item is in `inventory.md`.

> Style: classifications are deterministic functions of the data, not subjective. The same inputs would produce the same labels next month. Disagreement should be resolved against the data, not the prose.

---

## Inventory anomalies (resolve before per-entry triage)

These are not classifications — they are catalog/disk consistency findings the owner should resolve before any deletion PR lands.

### A1. `wiki` skill is on disk but missing from `src/catalog/manifest.json`

- **Evidence**: `find ./skills -maxdepth 2 -name 'SKILL.md'` returns `skills/wiki/SKILL.md`. `python3 -c "import json; m=json.load(open('src/catalog/manifest.json')); print(['wiki' in [s['name'] for s in m['skills']]])"` → `[False]`. The catalog hygiene test in `src/hooks/__tests__/skill-catalog-hygiene.test.ts` is the most likely surface to flag this.
- **Impact**: any code that iterates the catalog manifest (e.g. setup flow, doctor checks, `installable.ts`) will not see `wiki`, so it may not be installed by `omx setup`. Direct invocation via `$wiki` still works because the prompt loader resolves by filename.
- **Decision needed**: add the manifest row (`{ "name": "wiki", "category": "utility", "status": "active" }`) OR remove `skills/wiki/`. Pick by intent — is `$wiki` a supported user-facing surface, or an internal scratchpad?
- **Owner default recommendation**: ADD the manifest row. The skill body is 43-reference-rich and is invoked from documented places.

### A2. Four manifest entries with no disk counterpart

- **Names**: `configure-discord`, `configure-openclaw`, `configure-slack`, `configure-telegram`
- **Status**: all `merged → configure-notifications`.
- **Impact**: this is by design — `configure-notifications` is the canonical, and the four alias rows let `omx setup` accept legacy invocations. **No action needed**, listed here only so the next owner doesn't think it's a bug.

### A3. 17 on-disk skills not shipped via `plugins/oh-my-codex/skills/`

- **Deprecated (no longer shipped, by design)** (16): `ask-claude`, `ask-gemini`, `build-fix`, `deepsearch`, `ecomode`, `frontend-ui-ux`, `help`, `note`, `ralph-init`, `review`, `security-review`, `swarm`, `tdd`, `trace`, `visual-verdict`, `web-clone`
- **Other** (1): `git-master`
- **Impact**: these directories exist only as tombstones so `src/catalog/__tests__/schema.test.ts` and `src/catalog/manifest.json` stay consistent. They are not installed for users; the only consumer is the lint+catalog test surface.
- **Decision needed**: once the deprecated grace period passes, all 17 can be removed in a single sweep (PR-1 in the roadmap). Until then, leave alone.

---

## Skills

Entries grouped by classification, then alphabetical. Each entry: `<name>` → status → LOC, refs → classification → evidence → risk → one-line rationale.

### KEEP-AS-IS (16)

#### `ai-slop-cleaner`

- catalog: `status=active` `canonical=—` `category=shortcut`
- shape: LOC=148 · ref_count=16 · shipped=yes
- last commit: 2026-05-08 · docs: add UI design anti-slop signals (#2168)
- evidence: Active skill, 148 LOC, 16 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `analyze`

- catalog: `status=active` `canonical=—` `category=shortcut`
- shape: LOC=146 · ref_count=28 · shipped=yes
- last commit: 2026-05-10 · chore(skills): prune obsolete catalog entries
- evidence: Active skill, 146 LOC, 28 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `ask`

- catalog: `status=active` `canonical=—` `category=shortcut`
- shape: LOC=58 · ref_count=295 · shipped=yes
- last commit: 2026-05-06 · Retire obsolete OMX skills (#2132)
- evidence: Active skill, 58 LOC, 295 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `autopilot`

- catalog: `status=active` `canonical=—` `category=execution`
- shape: LOC=205 · ref_count=65 · shipped=yes
- last commit: 2026-05-22 · Guard autopilot ralplan consensus handoff (review fixes) (#2
- evidence: Active skill, 205 LOC, 65 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `autoresearch`

- catalog: `status=active` `canonical=—` `category=execution`
- shape: LOC=72 · ref_count=72 · shipped=yes
- last commit: 2026-05-22 · Clarify research planning boundaries
- evidence: Active skill, 72 LOC, 72 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `autoresearch-goal`

- catalog: `status=active` `canonical=—` `category=execution`
- shape: LOC=36 · ref_count=20 · shipped=yes
- last commit: 2026-05-22 · Clarify research planning boundaries
- evidence: Active skill, 36 LOC, 20 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `design`

- catalog: `status=active` `canonical=designer` `category=shortcut`
- shape: LOC=180 · ref_count=62 · shipped=yes
- last commit: 2026-05-11 · Establish DESIGN.md as the canonical design workflow
- evidence: Active skill, 180 LOC, 62 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `doctor`

- catalog: `status=active` `canonical=—` `category=utility`
- shape: LOC=239 · ref_count=34 · shipped=yes
- last commit: 2026-05-11 · Prefer CLI-first OMX setup over MCP defaults (#2258)
- evidence: Active skill, 239 LOC, 34 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `hud`

- catalog: `status=active` `canonical=—` `category=utility`
- shape: LOC=98 · ref_count=86 · shipped=yes
- last commit: 2026-03-11 · draft: bootstrap Rust CLI parity harness and initial omx com
- evidence: Active skill, 98 LOC, 86 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `performance-goal`

- catalog: `status=active` `canonical=—` `category=execution`
- shape: LOC=65 · ref_count=18 · shipped=yes
- last commit: 2026-05-05 · Protect goal workflows with snapshot reconciliation
- evidence: Active skill, 65 LOC, 18 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `pipeline`

- catalog: `status=active` `canonical=—` `category=execution`
- shape: LOC=97 · ref_count=32 · shipped=yes
- last commit: 2026-05-22 · Guard autopilot ralplan consensus handoff (review fixes) (#2
- evidence: Active skill, 97 LOC, 32 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `ralplan`

- catalog: `status=active` `canonical=plan` `category=planning`
- shape: LOC=187 · ref_count=77 · shipped=yes
- last commit: 2026-05-23 · Merge branch 'dev' into omx-issue-2453-ralplan-ultragoal-doc
- evidence: Active skill, 187 LOC, 77 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `ultragoal`

- catalog: `status=active` `canonical=—` `category=execution`
- shape: LOC=131 · ref_count=68 · shipped=yes
- last commit: 2026-05-20 · Avoid noisy fresh-session guidance in Ultragoal
- evidence: Active skill, 131 LOC, 68 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `ultraqa`

- catalog: `status=active` `canonical=—` `category=execution`
- shape: LOC=254 · ref_count=36 · shipped=yes
- last commit: 2026-05-11 · Ensure UltraQA catches adversarial e2e regressions (#2276)
- evidence: Active skill, 254 LOC, 36 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `ultrawork`

- catalog: `status=active` `canonical=—` `category=execution`
- shape: LOC=175 · ref_count=46 · shipped=yes
- last commit: 2026-05-20 · Make autopilot default to Ultragoal
- evidence: Active skill, 175 LOC, 46 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

#### `visual-ralph`

- catalog: `status=active` `canonical=designer` `category=shortcut`
- shape: LOC=161 · ref_count=17 · shipped=yes
- last commit: 2026-05-11 · Establish DESIGN.md as the canonical design workflow
- evidence: Active skill, 161 LOC, 17 refs. Sits cleanly in the current workflow set.
- action: No action.
- risk if removed: **low**
- rationale: Active and well-connected; nothing to change.

### KEEP-AS-IS (alias) (1)

#### `git-master`

- catalog: `status=alias` `canonical=git-master` `category=shortcut`
- shape: LOC=27 · ref_count=8 · shipped=no
- last commit: 2026-05-10 · chore(skills): prune obsolete catalog entries
- evidence: Alias for `git-master`. Shim is intentional. 27 LOC.
- action: No action unless the canonical is itself being changed.
- risk if removed: **low**
- rationale: Alias entry redirects to `git-master`; intentional surface.

### KEEP-AS-IS (internal) (1)

#### `worker`

- catalog: `status=internal` `canonical=—` `category=utility`
- shape: LOC=106 · ref_count=165 · shipped=yes
- last commit: 2026-03-17 · fix: stop generating skill agents (#897)
- evidence: Internal skill (106 LOC, refs 165). Used by an internal surface — do not expose, do not delete.
- action: No action.
- risk if removed: **low**
- rationale: Internal-only utility; ship-blocked by design.

### STREAMLINE (optional) (7)

#### `cancel`

- catalog: `status=active` `canonical=—` `category=utility`
- shape: LOC=399 · ref_count=67 · shipped=yes
- last commit: 2026-05-20 · Make autopilot default to Ultragoal
- evidence: Active and well-connected (67 refs) but heavy (399 LOC). Streamline is *optional* — only worth doing if the content rotted relative to current contracts.
- action: Defer until after the tombstone-deletion PR lands so the diff is easier to read.
- risk if removed: **low**
- rationale: Sized for its load, but a quality pass could still help.

#### `code-review`

- catalog: `status=active` `canonical=code-reviewer` `category=shortcut`
- shape: LOC=288 · ref_count=54 · shipped=yes
- last commit: 2026-05-11 · Prefer CLI-first OMX setup over MCP defaults (#2258)
- evidence: Active and well-connected (54 refs) but heavy (288 LOC). Streamline is *optional* — only worth doing if the content rotted relative to current contracts.
- action: Defer until after the tombstone-deletion PR lands so the diff is easier to read.
- risk if removed: **low**
- rationale: Sized for its load, but a quality pass could still help.

#### `deep-interview`

- catalog: `status=active` `canonical=—` `category=planning`
- shape: LOC=490 · ref_count=74 · shipped=yes
- last commit: 2026-05-21 · Prefer Ultragoal for durable follow-up guidance
- evidence: Active and well-connected (74 refs) but heavy (490 LOC). Streamline is *optional* — only worth doing if the content rotted relative to current contracts.
- action: Defer until after the tombstone-deletion PR lands so the diff is easier to read.
- risk if removed: **low**
- rationale: Sized for its load, but a quality pass could still help.

#### `plan`

- catalog: `status=active` `canonical=—` `category=planning`
- shape: LOC=277 · ref_count=204 · shipped=yes
- last commit: 2026-05-22 · Clarify research planning boundaries
- evidence: Active and well-connected (204 refs) but heavy (277 LOC). Streamline is *optional* — only worth doing if the content rotted relative to current contracts.
- action: Defer until after the tombstone-deletion PR lands so the diff is easier to read.
- risk if removed: **low**
- rationale: Sized for its load, but a quality pass could still help.

#### `ralph`

- catalog: `status=active` `canonical=—` `category=execution`
- shape: LOC=294 · ref_count=141 · shipped=yes
- last commit: 2026-05-19 · fix(ralph): enforce completion audit state contract (#2385)
- evidence: Active and well-connected (141 refs) but heavy (294 LOC). Streamline is *optional* — only worth doing if the content rotted relative to current contracts.
- action: Defer until after the tombstone-deletion PR lands so the diff is easier to read.
- risk if removed: **low**
- rationale: Sized for its load, but a quality pass could still help.

#### `skill`

- catalog: `status=active` `canonical=—` `category=utility`
- shape: LOC=836 · ref_count=160 · shipped=yes
- last commit: 2026-05-11 · Establish DESIGN.md as the canonical design workflow
- evidence: Active and well-connected (160 refs) but heavy (836 LOC). Streamline is *optional* — only worth doing if the content rotted relative to current contracts.
- action: Defer until after the tombstone-deletion PR lands so the diff is easier to read.
- risk if removed: **low**
- rationale: Sized for its load, but a quality pass could still help.

#### `team`

- catalog: `status=active` `canonical=—` `category=execution`
- shape: LOC=520 · ref_count=270 · shipped=yes
- last commit: 2026-05-21 · Prefer Ultragoal for durable follow-up guidance
- evidence: Active and well-connected (270 refs) but heavy (520 LOC). Streamline is *optional* — only worth doing if the content rotted relative to current contracts.
- action: Defer until after the tombstone-deletion PR lands so the diff is easier to read.
- risk if removed: **low**
- rationale: Sized for its load, but a quality pass could still help.

### CONSOLIDATE — already collapsed (4)

#### `configure-discord`

- catalog: `status=merged` `canonical=configure-notifications` `category=utility`
- shape: LOC=— · ref_count=0 · shipped=—
- last commit: — (no dir)
- evidence: Skill `configure-discord` exists only in the manifest, merged into `configure-notifications`. Manifest entry preserves the alias for `omx setup` lookups.
- action: No directory under `./skills/configure-discord/` — already done. Keep manifest row unless owner decides to fully drop the public name.
- risk if removed: **low**
- rationale: Already merged into `configure-notifications`; manifest row is the only remaining surface.

#### `configure-openclaw`

- catalog: `status=merged` `canonical=configure-notifications` `category=utility`
- shape: LOC=— · ref_count=0 · shipped=—
- last commit: — (no dir)
- evidence: Skill `configure-openclaw` exists only in the manifest, merged into `configure-notifications`. Manifest entry preserves the alias for `omx setup` lookups.
- action: No directory under `./skills/configure-openclaw/` — already done. Keep manifest row unless owner decides to fully drop the public name.
- risk if removed: **low**
- rationale: Already merged into `configure-notifications`; manifest row is the only remaining surface.

#### `configure-slack`

- catalog: `status=merged` `canonical=configure-notifications` `category=utility`
- shape: LOC=— · ref_count=0 · shipped=—
- last commit: — (no dir)
- evidence: Skill `configure-slack` exists only in the manifest, merged into `configure-notifications`. Manifest entry preserves the alias for `omx setup` lookups.
- action: No directory under `./skills/configure-slack/` — already done. Keep manifest row unless owner decides to fully drop the public name.
- risk if removed: **low**
- rationale: Already merged into `configure-notifications`; manifest row is the only remaining surface.

#### `configure-telegram`

- catalog: `status=merged` `canonical=configure-notifications` `category=utility`
- shape: LOC=— · ref_count=0 · shipped=—
- last commit: — (no dir)
- evidence: Skill `configure-telegram` exists only in the manifest, merged into `configure-notifications`. Manifest entry preserves the alias for `omx setup` lookups.
- action: No directory under `./skills/configure-telegram/` — already done. Keep manifest row unless owner decides to fully drop the public name.
- risk if removed: **low**
- rationale: Already merged into `configure-notifications`; manifest row is the only remaining surface.

### DEPRECATE (16)

#### `ask-claude`

- catalog: `status=deprecated` `canonical=—` `category=shortcut`
- shape: LOC=12 · ref_count=9 · shipped=no
- last commit: 2026-05-10 · chore(skills): prune obsolete catalog entries
- evidence: Hard-deprecated stub (12 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (9) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `ask-gemini`

- catalog: `status=deprecated` `canonical=—` `category=shortcut`
- shape: LOC=12 · ref_count=10 · shipped=no
- last commit: 2026-05-10 · chore(skills): prune obsolete catalog entries
- evidence: Hard-deprecated stub (12 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (10) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `build-fix`

- catalog: `status=deprecated` `canonical=—` `category=shortcut`
- shape: LOC=10 · ref_count=8 · shipped=no
- last commit: 2026-05-06 · Retire obsolete OMX skills (#2132)
- evidence: Hard-deprecated stub (10 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (8) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `deepsearch`

- catalog: `status=deprecated` `canonical=—` `category=shortcut`
- shape: LOC=10 · ref_count=5 · shipped=no
- last commit: 2026-05-06 · Retire obsolete OMX skills (#2132)
- evidence: Hard-deprecated stub (10 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (5) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `ecomode`

- catalog: `status=deprecated` `canonical=—` `category=execution`
- shape: LOC=114 · ref_count=10 · shipped=no
- last commit: 2026-05-11 · Prefer CLI-first OMX setup over MCP defaults (#2258)
- evidence: Hard-deprecated stub (114 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (10) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `frontend-ui-ux`

- catalog: `status=deprecated` `canonical=—` `category=shortcut`
- shape: LOC=16 · ref_count=10 · shipped=no
- last commit: 2026-05-11 · Establish DESIGN.md as the canonical design workflow
- evidence: Hard-deprecated stub (16 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (10) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `help`

- catalog: `status=deprecated` `canonical=—` `category=utility`
- shape: LOC=10 · ref_count=161 · shipped=no
- last commit: 2026-05-06 · Retire obsolete OMX skills (#2132)
- evidence: Hard-deprecated stub (10 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (161) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **medium**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `note`

- catalog: `status=deprecated` `canonical=—` `category=utility`
- shape: LOC=10 · ref_count=74 · shipped=no
- last commit: 2026-05-06 · Retire obsolete OMX skills (#2132)
- evidence: Hard-deprecated stub (10 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (74) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **medium**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `ralph-init`

- catalog: `status=deprecated` `canonical=—` `category=utility`
- shape: LOC=10 · ref_count=6 · shipped=no
- last commit: 2026-05-06 · Retire obsolete OMX skills (#2132)
- evidence: Hard-deprecated stub (10 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (6) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `review`

- catalog: `status=deprecated` `canonical=—` `category=shortcut`
- shape: LOC=10 · ref_count=163 · shipped=no
- last commit: 2026-05-06 · Retire obsolete OMX skills (#2132)
- evidence: Hard-deprecated stub (10 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (163) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **medium**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `security-review`

- catalog: `status=deprecated` `canonical=—` `category=shortcut`
- shape: LOC=10 · ref_count=8 · shipped=no
- last commit: 2026-05-06 · Retire obsolete OMX skills (#2132)
- evidence: Hard-deprecated stub (10 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (8) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `swarm`

- catalog: `status=deprecated` `canonical=—` `category=execution`
- shape: LOC=12 · ref_count=17 · shipped=no
- last commit: 2026-05-10 · chore(skills): prune obsolete catalog entries
- evidence: Hard-deprecated stub (12 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (17) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `tdd`

- catalog: `status=deprecated` `canonical=—` `category=shortcut`
- shape: LOC=104 · ref_count=6 · shipped=no
- last commit: 2026-05-11 · Prefer CLI-first OMX setup over MCP defaults (#2258)
- evidence: Hard-deprecated stub (104 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (6) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `trace`

- catalog: `status=deprecated` `canonical=—` `category=utility`
- shape: LOC=10 · ref_count=41 · shipped=no
- last commit: 2026-05-06 · Retire obsolete OMX skills (#2132)
- evidence: Hard-deprecated stub (10 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (41) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **medium**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `visual-verdict`

- catalog: `status=deprecated` `canonical=—` `category=shortcut`
- shape: LOC=10 · ref_count=9 · shipped=no
- last commit: 2026-05-06 · Retire obsolete OMX skills (#2132)
- evidence: Hard-deprecated stub (10 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (9) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

#### `web-clone`

- catalog: `status=deprecated` `canonical=—` `category=shortcut`
- shape: LOC=357 · ref_count=10 · shipped=no
- last commit: 2026-05-10 · chore(skills): prune obsolete catalog entries
- evidence: Hard-deprecated stub (357 LOC). Body explicitly says "Do not invoke or route this skill." Reference count (10) is concentrated in catalog/manifest entries and lint contract tests, not real consumers.
- action: Once owner confirms no external `$<name>` users remain, remove the directory and the manifest row in a single sweep.
- risk if removed: **low**
- rationale: Tombstone — body is already a redirect; remove directory + manifest row after grace period.

### AMBIGUOUS — NEEDS OWNER DECISION (5)

#### `best-practice-research`

- catalog: `status=active` `canonical=—` `category=planning`
- shape: LOC=83 · ref_count=12 · shipped=yes
- last commit: 2026-05-22 · Clarify research planning boundaries
- evidence: Active skill but low connectivity (12 refs). Either the skill is doing important work that the rest of the codebase forgot to advertise, or it is quietly orphaned.
- action: Owner should confirm it is still in the autopilot/ralplan/team narrative. If not, downgrade to internal or move into a parent skill's body.
- risk if removed: **medium**
- rationale: Data is inconclusive; owner sees the case better than the auditor.

#### `configure-notifications`

- catalog: `status=active` `canonical=—` `category=utility`
- shape: LOC=287 · ref_count=6 · shipped=yes
- last commit: 2026-04-13 · Release 0.12.6
- evidence: Active skill but low connectivity (6 refs). Either the skill is doing important work that the rest of the codebase forgot to advertise, or it is quietly orphaned.
- action: Owner should confirm it is still in the autopilot/ralplan/team narrative. If not, downgrade to internal or move into a parent skill's body.
- risk if removed: **medium**
- rationale: Data is inconclusive; owner sees the case better than the auditor.

#### `omx-setup`

- catalog: `status=active` `canonical=—` `category=utility`
- shape: LOC=135 · ref_count=15 · shipped=yes
- last commit: 2026-05-21 · Unblock plugin-scoped hooks from verifier
- evidence: Active skill but low connectivity (15 refs). Either the skill is doing important work that the rest of the codebase forgot to advertise, or it is quietly orphaned.
- action: Owner should confirm it is still in the autopilot/ralplan/team narrative. If not, downgrade to internal or move into a parent skill's body.
- risk if removed: **medium**
- rationale: Data is inconclusive; owner sees the case better than the auditor.

#### `prometheus-strict`

- catalog: `status=active` `canonical=—` `category=planning`
- shape: LOC=219 · ref_count=11 · shipped=yes
- last commit: 2026-05-23 · feat(prometheus-strict): require second planning round
- evidence: Active skill but low connectivity (11 refs). Either the skill is doing important work that the rest of the codebase forgot to advertise, or it is quietly orphaned.
- action: Owner should confirm it is still in the autopilot/ralplan/team narrative. If not, downgrade to internal or move into a parent skill's body.
- risk if removed: **medium**
- rationale: Data is inconclusive; owner sees the case better than the auditor.

#### `wiki`

- catalog: `status=NOT_IN_MANIFEST` `canonical=—` `category=—`
- shape: LOC=57 · ref_count=43 · shipped=yes
- last commit: 2026-05-11 · Prefer CLI-first OMX setup over MCP defaults (#2258)
- evidence: On-disk skill `wiki` is not registered in `src/catalog/manifest.json`. Either add a manifest entry (so install/lint surfaces see it) or remove the directory.
- action: Tests in `src/catalog/__tests__/schema.test.ts` reject unknown skills if they are not core; consistency tests in `src/hooks/__tests__/skill-catalog-hygiene.test.ts` may already flag this. Verify before adding.
- risk if removed: **medium**
- rationale: Data is inconclusive; owner sees the case better than the auditor.

---

## Agents

Same format as skills. The 3 entries with `status=NOT_IN_MANIFEST` are the non-installable prompt assets listed in `src/agents/policy.ts` (`explore-harness`, `sisyphus-lite`, `team-orchestrator`).

### KEEP-AS-IS (18)

#### `analyst`

- catalog: `status=active` `canonical=—` `category=build`
- shape: ref_count=15
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=frontier · routingRole=leader · tools=analysis
- evidence: Active agent, 15 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `architect`

- catalog: `status=active` `canonical=—` `category=build`
- shape: ref_count=111
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=frontier · routingRole=leader · tools=read-only
- evidence: Active agent, 111 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `code-reviewer`

- catalog: `status=active` `canonical=—` `category=review`
- shape: ref_count=21
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=frontier · routingRole=leader · tools=read-only
- evidence: Active agent, 21 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `critic`

- catalog: `status=active` `canonical=—` `category=coordination`
- shape: ref_count=56
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=frontier · routingRole=leader · tools=read-only
- evidence: Active agent, 56 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `debugger`

- catalog: `status=active` `canonical=—` `category=build`
- shape: ref_count=25
- definition (`src/agents/definitions.ts`): posture=deep-worker · modelClass=standard · routingRole=executor · tools=analysis
- evidence: Active agent, 25 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `dependency-expert`

- catalog: `status=active` `canonical=—` `category=domain`
- shape: ref_count=14
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=standard · routingRole=specialist · tools=analysis
- evidence: Active agent, 14 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `designer`

- catalog: `status=active` `canonical=—` `category=domain`
- shape: ref_count=24
- definition (`src/agents/definitions.ts`): posture=deep-worker · modelClass=standard · routingRole=executor · tools=execution
- evidence: Active agent, 24 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `executor`

- catalog: `status=active` `canonical=—` `category=build`
- shape: ref_count=114
- definition (`src/agents/definitions.ts`): posture=— · modelClass=— · routingRole=— · tools=—
- evidence: Active agent, 114 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `explore`

- catalog: `status=active` `canonical=—` `category=build`
- shape: ref_count=99
- definition (`src/agents/definitions.ts`): posture=fast-lane · modelClass=fast · routingRole=specialist · tools=read-only
- evidence: Active agent, 99 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `planner`

- catalog: `status=active` `canonical=—` `category=build`
- shape: ref_count=35
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=frontier · routingRole=leader · tools=analysis
- evidence: Active agent, 35 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `prometheus-strict-metis`

- catalog: `status=active` `canonical=—` `category=coordination`
- shape: ref_count=7
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=frontier · routingRole=leader · tools=analysis
- evidence: Active agent, 7 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `prometheus-strict-momus`

- catalog: `status=active` `canonical=—` `category=coordination`
- shape: ref_count=7
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=frontier · routingRole=leader · tools=analysis
- evidence: Active agent, 7 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `prometheus-strict-oracle`

- catalog: `status=active` `canonical=—` `category=coordination`
- shape: ref_count=7
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=standard · routingRole=leader · tools=analysis
- evidence: Active agent, 7 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `researcher`

- catalog: `status=active` `canonical=—` `category=domain`
- shape: ref_count=33
- definition (`src/agents/definitions.ts`): posture=fast-lane · modelClass=standard · routingRole=specialist · tools=analysis
- evidence: Active agent, 33 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `test-engineer`

- catalog: `status=active` `canonical=—` `category=domain`
- shape: ref_count=28
- definition (`src/agents/definitions.ts`): posture=deep-worker · modelClass=frontier · routingRole=executor · tools=execution
- evidence: Active agent, 28 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `verifier`

- catalog: `status=active` `canonical=—` `category=build`
- shape: ref_count=23
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=standard · routingRole=leader · tools=analysis
- evidence: Active agent, 23 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `vision`

- catalog: `status=active` `canonical=—` `category=coordination`
- shape: ref_count=17
- definition (`src/agents/definitions.ts`): posture=fast-lane · modelClass=frontier · routingRole=specialist · tools=read-only
- evidence: Active agent, 17 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

#### `writer`

- catalog: `status=active` `canonical=—` `category=domain`
- shape: ref_count=21
- definition (`src/agents/definitions.ts`): posture=fast-lane · modelClass=standard · routingRole=specialist · tools=execution
- evidence: Active agent, 21 refs. Loaded into the current routing/pipeline narrative.
- action: No action.
- risk if removed: **low**
- rationale: Used by current routing/pipeline.

### KEEP-AS-IS (internal) (2)

#### `code-simplifier`

- catalog: `status=internal` `canonical=—` `category=domain`
- shape: ref_count=11
- definition (`src/agents/definitions.ts`): posture=deep-worker · modelClass=frontier · routingRole=executor · tools=execution
- evidence: Intentional internal-only agent. Not surfaced for direct routing.
- action: No action.
- risk if removed: **low**
- rationale: Intentional internal-only.

#### `team-executor`

- catalog: `status=internal` `canonical=—` `category=build`
- shape: ref_count=9
- definition (`src/agents/definitions.ts`): posture=— · modelClass=— · routingRole=— · tools=—
- evidence: Intentional internal-only agent. Not surfaced for direct routing.
- action: No action.
- risk if removed: **low**
- rationale: Intentional internal-only.

### KEEP-AS-IS (non-installable asset) (3)

#### `explore-harness`

- catalog: `status=NOT_IN_MANIFEST` `canonical=—` `category=—`
- shape: ref_count=12
- definition (`src/agents/definitions.ts`): posture=— · modelClass=— · routingRole=— · tools=—
- evidence: Listed in `NON_NATIVE_AGENT_PROMPT_ASSETS` (`src/agents/policy.ts`). Prompt is bundled into skills or used as a sub-prompt, not as a standalone Codex agent.
- action: Verify the consuming skill (e.g. `sisyphus-lite` → `ralph`, `team-orchestrator` → `team`, `explore-harness` → `explore`) still pulls the prompt. If not, this is dead code and should be deleted in a follow-up sweep.
- risk if removed: **medium**
- rationale: Prompt asset for an embedded role; not directly installed.

#### `sisyphus-lite`

- catalog: `status=NOT_IN_MANIFEST` `canonical=—` `category=—`
- shape: ref_count=5
- definition (`src/agents/definitions.ts`): posture=— · modelClass=— · routingRole=— · tools=—
- evidence: Listed in `NON_NATIVE_AGENT_PROMPT_ASSETS` (`src/agents/policy.ts`). Prompt is bundled into skills or used as a sub-prompt, not as a standalone Codex agent.
- action: Verify the consuming skill (e.g. `sisyphus-lite` → `ralph`, `team-orchestrator` → `team`, `explore-harness` → `explore`) still pulls the prompt. If not, this is dead code and should be deleted in a follow-up sweep.
- risk if removed: **medium**
- rationale: Prompt asset for an embedded role; not directly installed.

#### `team-orchestrator`

- catalog: `status=NOT_IN_MANIFEST` `canonical=—` `category=—`
- shape: ref_count=2
- definition (`src/agents/definitions.ts`): posture=— · modelClass=— · routingRole=— · tools=—
- evidence: Listed in `NON_NATIVE_AGENT_PROMPT_ASSETS` (`src/agents/policy.ts`). Prompt is bundled into skills or used as a sub-prompt, not as a standalone Codex agent.
- action: Verify the consuming skill (e.g. `sisyphus-lite` → `ralph`, `team-orchestrator` → `team`, `explore-harness` → `explore`) still pulls the prompt. If not, this is dead code and should be deleted in a follow-up sweep.
- risk if removed: **low**
- rationale: Prompt asset for an embedded role; not directly installed.

### CONSOLIDATE (10)

#### `api-reviewer`

- catalog: `status=merged` `canonical=code-reviewer` `category=review`
- shape: ref_count=9
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=standard · routingRole=leader · tools=read-only
- evidence: Already merged into `code-reviewer` per catalog. Entry kept in `AGENT_DEFINITIONS` + `prompts/api-reviewer.md` only for `omx setup` parity with older installs.
- action: After ≥1 release cycle of merged status, remove the `AGENT_DEFINITIONS` entry and the `prompts/api-reviewer.md` file. Keep the manifest row as `merged` for upgrade-path stability.
- risk if removed: **low**
- rationale: Already collapsed into `code-reviewer`; entry stays for upgrade-path parity, schedule removal after grace cycle.

#### `information-architect`

- catalog: `status=merged` `canonical=designer` `category=product`
- shape: ref_count=7
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=standard · routingRole=specialist · tools=analysis
- evidence: Already merged into `designer` per catalog. Entry kept in `AGENT_DEFINITIONS` + `prompts/information-architect.md` only for `omx setup` parity with older installs.
- action: After ≥1 release cycle of merged status, remove the `AGENT_DEFINITIONS` entry and the `prompts/information-architect.md` file. Keep the manifest row as `merged` for upgrade-path stability.
- risk if removed: **low**
- rationale: Already collapsed into `designer`; entry stays for upgrade-path parity, schedule removal after grace cycle.

#### `performance-reviewer`

- catalog: `status=merged` `canonical=code-reviewer` `category=review`
- shape: ref_count=13
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=standard · routingRole=leader · tools=read-only
- evidence: Already merged into `code-reviewer` per catalog. Entry kept in `AGENT_DEFINITIONS` + `prompts/performance-reviewer.md` only for `omx setup` parity with older installs.
- action: After ≥1 release cycle of merged status, remove the `AGENT_DEFINITIONS` entry and the `prompts/performance-reviewer.md` file. Keep the manifest row as `merged` for upgrade-path stability.
- risk if removed: **low**
- rationale: Already collapsed into `code-reviewer`; entry stays for upgrade-path parity, schedule removal after grace cycle.

#### `product-analyst`

- catalog: `status=merged` `canonical=analyst` `category=product`
- shape: ref_count=8
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=standard · routingRole=specialist · tools=analysis
- evidence: Already merged into `analyst` per catalog. Entry kept in `AGENT_DEFINITIONS` + `prompts/product-analyst.md` only for `omx setup` parity with older installs.
- action: After ≥1 release cycle of merged status, remove the `AGENT_DEFINITIONS` entry and the `prompts/product-analyst.md` file. Keep the manifest row as `merged` for upgrade-path stability.
- risk if removed: **low**
- rationale: Already collapsed into `analyst`; entry stays for upgrade-path parity, schedule removal after grace cycle.

#### `product-manager`

- catalog: `status=merged` `canonical=analyst` `category=product`
- shape: ref_count=11
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=standard · routingRole=leader · tools=analysis
- evidence: Already merged into `analyst` per catalog. Entry kept in `AGENT_DEFINITIONS` + `prompts/product-manager.md` only for `omx setup` parity with older installs.
- action: After ≥1 release cycle of merged status, remove the `AGENT_DEFINITIONS` entry and the `prompts/product-manager.md` file. Keep the manifest row as `merged` for upgrade-path stability.
- risk if removed: **low**
- rationale: Already collapsed into `analyst`; entry stays for upgrade-path parity, schedule removal after grace cycle.

#### `qa-tester`

- catalog: `status=merged` `canonical=test-engineer` `category=domain`
- shape: ref_count=9
- definition (`src/agents/definitions.ts`): posture=deep-worker · modelClass=standard · routingRole=executor · tools=execution
- evidence: Already merged into `test-engineer` per catalog. Entry kept in `AGENT_DEFINITIONS` + `prompts/qa-tester.md` only for `omx setup` parity with older installs.
- action: After ≥1 release cycle of merged status, remove the `AGENT_DEFINITIONS` entry and the `prompts/qa-tester.md` file. Keep the manifest row as `merged` for upgrade-path stability.
- risk if removed: **low**
- rationale: Already collapsed into `test-engineer`; entry stays for upgrade-path parity, schedule removal after grace cycle.

#### `quality-reviewer`

- catalog: `status=merged` `canonical=code-reviewer` `category=review`
- shape: ref_count=17
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=standard · routingRole=leader · tools=read-only
- evidence: Already merged into `code-reviewer` per catalog. Entry kept in `AGENT_DEFINITIONS` + `prompts/quality-reviewer.md` only for `omx setup` parity with older installs.
- action: After ≥1 release cycle of merged status, remove the `AGENT_DEFINITIONS` entry and the `prompts/quality-reviewer.md` file. Keep the manifest row as `merged` for upgrade-path stability.
- risk if removed: **medium**
- rationale: Already collapsed into `code-reviewer`; entry stays for upgrade-path parity, schedule removal after grace cycle.

#### `quality-strategist`

- catalog: `status=merged` `canonical=verifier` `category=domain`
- shape: ref_count=6
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=standard · routingRole=leader · tools=analysis
- evidence: Already merged into `verifier` per catalog. Entry kept in `AGENT_DEFINITIONS` + `prompts/quality-strategist.md` only for `omx setup` parity with older installs.
- action: After ≥1 release cycle of merged status, remove the `AGENT_DEFINITIONS` entry and the `prompts/quality-strategist.md` file. Keep the manifest row as `merged` for upgrade-path stability.
- risk if removed: **low**
- rationale: Already collapsed into `verifier`; entry stays for upgrade-path parity, schedule removal after grace cycle.

#### `style-reviewer`

- catalog: `status=merged` `canonical=code-reviewer` `category=review`
- shape: ref_count=15
- definition (`src/agents/definitions.ts`): posture=fast-lane · modelClass=fast · routingRole=specialist · tools=read-only
- evidence: Already merged into `code-reviewer` per catalog. Entry kept in `AGENT_DEFINITIONS` + `prompts/style-reviewer.md` only for `omx setup` parity with older installs.
- action: After ≥1 release cycle of merged status, remove the `AGENT_DEFINITIONS` entry and the `prompts/style-reviewer.md` file. Keep the manifest row as `merged` for upgrade-path stability.
- risk if removed: **low**
- rationale: Already collapsed into `code-reviewer`; entry stays for upgrade-path parity, schedule removal after grace cycle.

#### `ux-researcher`

- catalog: `status=merged` `canonical=designer` `category=product`
- shape: ref_count=8
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=standard · routingRole=specialist · tools=analysis
- evidence: Already merged into `designer` per catalog. Entry kept in `AGENT_DEFINITIONS` + `prompts/ux-researcher.md` only for `omx setup` parity with older installs.
- action: After ≥1 release cycle of merged status, remove the `AGENT_DEFINITIONS` entry and the `prompts/ux-researcher.md` file. Keep the manifest row as `merged` for upgrade-path stability.
- risk if removed: **low**
- rationale: Already collapsed into `designer`; entry stays for upgrade-path parity, schedule removal after grace cycle.

### DEPRECATE (2)

#### `build-fixer`

- catalog: `status=deprecated` `canonical=—` `category=domain`
- shape: ref_count=5
- definition (`src/agents/definitions.ts`): posture=deep-worker · modelClass=standard · routingRole=executor · tools=execution
- evidence: Catalog marks this agent deprecated. ref_count 5 is mostly catalog/test boilerplate.
- action: Confirm no skill body still names it; if clean, remove `AGENT_DEFINITIONS` entry, `prompts/build-fixer.md`, and any policy carve-outs.
- risk if removed: **low**
- rationale: Catalog says deprecated and references are catalog/test boilerplate.

#### `security-reviewer`

- catalog: `status=deprecated` `canonical=—` `category=review`
- shape: ref_count=5
- definition (`src/agents/definitions.ts`): posture=frontier-orchestrator · modelClass=frontier · routingRole=leader · tools=read-only
- evidence: Catalog marks this agent deprecated. ref_count 5 is mostly catalog/test boilerplate.
- action: Confirm no skill body still names it; if clean, remove `AGENT_DEFINITIONS` entry, `prompts/security-reviewer.md`, and any policy carve-outs.
- risk if removed: **low**
- rationale: Catalog says deprecated and references are catalog/test boilerplate.

### AMBIGUOUS — NEEDS OWNER DECISION (1)

#### `git-master`

- catalog: `status=active` `canonical=—` `category=domain`
- shape: ref_count=8
- definition (`src/agents/definitions.ts`): posture=deep-worker · modelClass=standard · routingRole=executor · tools=execution
- evidence: Active agent with low connectivity (8 refs). Either underused or the work is delegated implicitly via routing.
- action: Owner should confirm the agent has a live consumer. If not, downgrade to internal or merge into the closest neighbor.
- risk if removed: **medium**
- rationale: Active in catalog but low connectivity in code+skill bodies.

---

## Summary

### Skills

| classification | count |
|----------------|-------|
| KEEP-AS-IS | 16 |
| KEEP-AS-IS (alias) | 1 |
| KEEP-AS-IS (internal) | 1 |
| STREAMLINE (optional) | 7 |
| CONSOLIDATE — already collapsed | 4 |
| DEPRECATE | 16 |
| AMBIGUOUS — NEEDS OWNER DECISION | 5 |
| **total** | 50 |

### Agents

| classification | count |
|----------------|-------|
| KEEP-AS-IS | 18 |
| KEEP-AS-IS (internal) | 2 |
| KEEP-AS-IS (non-installable asset) | 3 |
| CONSOLIDATE | 10 |
| DEPRECATE | 2 |
| AMBIGUOUS — NEEDS OWNER DECISION | 1 |
| **total** | 36 |

Read this alongside `connectivity-roadmap.md` for the proposed PR-by-PR sequence to act on these classifications.

---

*Generated for owner review. Re-run by regenerating `notes/combined.json` and re-running the bloat-audit generator.*
