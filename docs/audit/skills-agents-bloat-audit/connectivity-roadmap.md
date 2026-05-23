# Connectivity roadmap — skills + agents (omx)

Generated 2026-05-23. Companion to `inventory.md` and `bloat-audit.md`. This document is about the **organic connectivity** between skills and agents that the owner asked about: where a useful surface exists but the next-step links to its neighbors are missing, so the model can't find it during routing.

It also lays out the recommended **PR-by-PR sequence** to land the bloat-audit cleanup safely. Every PR is scoped to be ≤30-minute review.

---

## How the data was collected

Three signals were combined:

1. **`rg -l -F '<name>' skills/ src/ prompts/ templates/`** — total reference count per skill and per agent (from `inventory.md`). False positives possible for English-word names (`ask`, `plan`, `team`, `note`, `review`, `help`).
2. **Skill body → agent name** — does each `SKILL.md` textually mention any agent name? Builds the *narrative coupling* matrix (in `inventory.md` § Skill → agent reference matrix).
3. **Agent prompt → skill name** — does each `prompts/<name>.md` textually mention any skill name?

Read against this evidence: a skill or agent is *orphan-ish* if it is `status=active` in the catalog AND it falls into ≥1 of the following:

- zero other-skill bodies reference it,
- zero active agents reference it (and it is a workflow/orchestration skill where agent routing would be expected),
- zero active skills reference it (and it is a workflow/specialist agent where skill orientation would be expected),
- its total `ref_count` is ≤ 15 AND it isn't a core skill.

False-positive caveat: `ask` and `cancel` and `configure-notifications` and `omx-setup` mention no agents — but this is *not* orphan behavior, it is correct (they are infrastructure surfaces below the routing layer). Treat them as KEEP-AS-IS.

---

## Section 1 — Orphan analysis (the data)

### 1.1 Active skills whose body mentions zero active agents

| skill | analysis |
|-------|----------|
| `ask` | Acceptable — `ask` is an *advisor CLI shim*, lives below the agent layer. No fix needed. |
| `cancel` | Acceptable — `cancel` clears mode state; no agent role belongs in its body. No fix needed. |
| `configure-notifications` | Acceptable — pure config skill. No fix needed. |
| `omx-setup` | Acceptable — pure install/setup skill. No fix needed. |
| `performance-goal` | **Orphan candidate**. The skill defines an "Agent Loop" section but does not name any of `executor`, `test-engineer`, `verifier`, or `quality-strategist`. A reader (or the model in routing) has no signal of which agent runs the optimization patches or the evaluator. |

### 1.2 Active skills NOT referenced by any other skill body

| skill | analysis |
|-------|----------|
| `prometheus-strict` | Entry-point skill. It is *meant* to be invoked directly (`$prometheus-strict`), so a one-way fan-out is expected. But neither `autopilot` nor `plan` nor `ralplan` currently link to it as a deeper-rigor alternative — and the bloat-audit shows `autopilot` already chains `$deep-interview → $ralplan`, so there's a clean place to mention `prometheus-strict` as the *high-stakes* variant. **Soft fix recommended.** |

### 1.3 Active skills with weak inter-skill connectivity (≤ 2 other-skill refs)

| skill | currently referenced by | observation |
|-------|------------------------|-------------|
| `ai-slop-cleaner` | `ralph`, `ultragoal` | `autopilot` also runs a deslop step in spirit but never names this skill. Adding the name to `autopilot`'s skill body would close the loop. |
| `configure-notifications` | `omx-setup` | After deprecated `help` is removed (PR-1), this stays connected via `omx-setup`. No fix needed. |
| `doctor` | `help` (deprecated), `omx-setup` | After `help` is removed, falls to 1 ref. **Soft fix**: cross-reference `doctor` from `omx-setup`'s troubleshooting paragraph and from `configure-notifications`'s "diagnose webhook issues" section. |
| `omx-setup` | `help` (deprecated) | After `help` is removed, ZERO inter-skill refs. **Soft fix**: cross-reference `omx-setup` from `doctor`'s recovery instructions. |

### 1.4 Active agents with low total reference count

| agent | refs | notes |
|-------|------|-------|
| `prometheus-strict-metis` | 7 | Tightly coupled to `prometheus-strict` skill. Working as intended. No fix. |
| `prometheus-strict-momus` | 7 | Same as above. |
| `prometheus-strict-oracle` | 7 | Same as above. |
| `git-master` (agent) | 8 | Mostly catalog/template refs. Not mentioned by `$code-review` or `$plan` bodies even though commit hygiene is a natural part of either. **Soft fix**: add a "for commit strategy, defer to `git-master`" line in `code-review` and in `plan` (post-implementation step). |
| `dependency-expert` | 14 | Referenced from `best-practice-research` only. Could be cross-linked from `analyze` (when a question is about an external SDK) and from `ralplan` (when a plan touches a new dependency). |
| `vision` | 17 | Used by `team` and `visual-ralph`. Could also be cross-linked from `code-review` (for screenshots) and `design` (for reference images). |

### 1.5 Agents with empty `prompts/<name>.md` skill mentions

All 33 active agents mention at least one active skill in their prompt body (`ag_to_sk` returned no empty sets). The most-common backlink is to `$ask`, which is mentioned by **every** agent prompt — confirming `ask` is the canonical advisor backstop. No orphan agents on this signal.

---

## Section 2 — Connectivity fixes

Recommendations are grouped by effort. Each carries the proposed concrete edit and which file would change. No edits are made in this PR — they are queued for follow-ups.

### 2.1 Quick wins (single-file edit, <30 min each)

| # | edit | file | proposed change | risk |
|---|------|------|-----------------|------|
| Q1 | Name agents in `performance-goal` Agent Loop | `skills/performance-goal/SKILL.md` | Step 3 (`Optimize in small reversible patches`) → "via `executor`" or "via the planner+executor lane". Step 4 (`Run the evaluator and related regression tests`) → "via `test-engineer` when adjustments to the eval suite are needed". | low — pure documentation |
| Q2 | Cross-link `omx-setup` ↔ `doctor` | `skills/omx-setup/SKILL.md`, `skills/doctor/SKILL.md` | In `omx-setup`'s troubleshooting paragraph add: "If setup completes but a subsystem misbehaves, run `$doctor`." In `doctor`'s top: "If `omx` itself isn't installed yet, run `$omx-setup` first." | low |
| Q3 | Cross-link `configure-notifications` → `doctor` | `skills/configure-notifications/SKILL.md` | Bottom of the file: "If a webhook fails after configuration, run `$doctor` to surface logged delivery errors." | low |
| Q4 | Cross-link `autopilot` → `ai-slop-cleaner` | `skills/autopilot/SKILL.md` | In the "+ optional cleanup" line in the Purpose block: explicitly name `$ai-slop-cleaner`. Currently the body refers only obliquely to anti-slop. | low |
| Q5 | Cross-link `code-review` → `git-master` | `skills/code-review/SKILL.md` | In the post-review/commit-prep step: "For commit-message rewrite or split, defer to the `git-master` agent." | low |
| Q6 | Cross-link `analyze` → `dependency-expert` | `skills/analyze/SKILL.md` | In the "When the question is about an external SDK/package, prefer `dependency-expert`" subsection: replace soft phrasing with the explicit agent name. | low |
| Q7 | Cross-link `ralplan` → `dependency-expert` | `skills/ralplan/SKILL.md` | In the planning-time risk-flag section: "When the plan touches a new SDK or external API, escalate to `dependency-expert` before sequencing." | low |
| Q8 | Cross-link `design` → `vision` | `skills/design/SKILL.md` | In the reference-image acceptance step: "For raster reference comparison, route image analysis to `vision`." | low |
| Q9 | Add `prometheus-strict` mention to `autopilot` | `skills/autopilot/SKILL.md` | One-line note: "For high-stakes / mathematically gated work, swap `$deep-interview` for `$prometheus-strict`." | low |
| Q10 | Resolve `wiki` skill manifest gap | `src/catalog/manifest.json` | Add `{ "name": "wiki", "category": "utility", "status": "active" }` (see anomaly A1 in `bloat-audit.md`). | medium — verify lint contract test |

### 2.2 Medium-effort (multi-file or requires test)

| # | edit | files | proposed change | risk |
|---|------|-------|-----------------|------|
| M1 | Land the deprecated-skill tombstone sweep | `skills/{ask-claude,ask-gemini,build-fix,deepsearch,ecomode,frontend-ui-ux,help,note,ralph-init,review,security-review,swarm,tdd,trace,visual-verdict,web-clone}/`, `src/catalog/manifest.json`, plus any test that hard-codes those names | Delete the 16 tombstone directories; downgrade their manifest rows from `status=deprecated` to actually-removed-from-shipped (a `removed` status, OR drop the rows if the schema already accepts removal). Update `src/catalog/__tests__/schema.test.ts` and `src/hooks/__tests__/skill-catalog-hygiene.test.ts`. | medium — touches catalog tests. Pre-flight: confirm `omx setup` no longer warns missing aliases. |
| M2 | Land the merged-agent sweep | `src/agents/definitions.ts`, `prompts/{api-reviewer,quality-reviewer,style-reviewer,performance-reviewer,quality-strategist,qa-tester,product-manager,product-analyst,ux-researcher,information-architect}.md`, `src/agents/__tests__/definitions.test.ts` | Remove the 10 merged-agent entries from `AGENT_DEFINITIONS` and their `prompts/<name>.md` files. Keep manifest rows as `merged → <canonical>` so upgrade paths from old installs still resolve. | medium — agent prompts may still be referenced by lint tests; verify. |
| M3 | Land the deprecated-agent sweep | `src/agents/definitions.ts`, `prompts/{security-reviewer,build-fixer}.md` | Remove the 2 `deprecated` agent entries and their prompts. | low — refs are catalog/test only |
| M4 | Reconcile `git-master` skill alias | `skills/git-master/SKILL.md` | Confirm intent: keep the skill alias (27 LOC) as a shim for `$git-master` → `git-master` agent invocation. If yes, leave as-is. If owner prefers a pure-agent route, remove the skill alias and bump the agent's `category` or its routing surface accordingly. | medium — affects user-facing `$git-master` invocation |

### 2.3 Strategic items (owner judgment required)

| # | proposal | rationale |
|---|----------|-----------|
| S1 | Decide the long-term fate of the 4 `configure-*` merged manifest rows. | They're currently kept to absorb legacy invocations like `$configure-discord`. Owner can decide if they keep them for ≥2 more releases (low cost, modest catalog noise) or drop them now (cleaner but breaks one-shot users who still type the merged names). |
| S2 | Decide whether `prometheus-strict-{metis,momus,oracle}` should remain three separate `AGENT_DEFINITIONS` rows or become one composite agent with three modes. | Today each is a distinct entry but they only ever run together inside `prometheus-strict`. Three rows make the prompt boundary explicit; one composite simplifies the catalog at the cost of a longer single prompt. Owner-only call. |
| S3 | Decide whether `team-executor` should remain an `internal` agent or become `active`. | Today it is internal; `team` skill body still mentions it. Promoting it to active makes `$team-executor` directly invocable; keeping it internal preserves the routing-through-`team` invariant. |
| S4 | Decide whether `worker` skill should stay `internal` or be split. | `worker` has 165 references — by far the highest among internal skills — because it is referenced by every team-runtime test. Owner should confirm this is intended; if so, no change. If `worker` is becoming a public-facing concept, promote it. |
| S5 | Decide whether `wiki` skill is a supported user surface. | The catalog manifest gap (anomaly A1) is the immediate symptom. The deeper question is whether the wiki workflow is a first-class skill (and so needs the manifest row + install path) or an internal Code-side surface (and so should not be in `./skills/` at all). |
| S6 | Decide whether `performance-goal` belongs as its own skill or as a variant of `ultragoal`. | `performance-goal` is the only `*-goal` skill besides `ultragoal` and `autoresearch-goal`. Either keep all three as siblings (current shape) or fold `performance-goal` into `ultragoal` as a `--performance` mode. The latter would let `ultragoal`'s evaluator-gated loop subsume it. |

---

## Section 3 — Suggested PR-split

The proposed sequence is **deprecations first**, **consolidations second**, **connectivity edits third**. This ordering ensures every connectivity fix lands against the final shape of the catalog rather than a transitional one, and avoids the wasted review-time of editing a soon-to-be-removed file.

Each PR is sized so the review is ≤30 min for someone who has read this document. All PRs target `dev`, not `main`.

### Phase A — Tombstone deletion (clears the floor)

**PR-1** — `chore(skills): remove 16 deprecated tombstone skills`
- Type: `chore` (deletion)
- Touches: 16 skill directories + `src/catalog/manifest.json` + 2 catalog tests
- Scope: delete the 16 directories listed in M1; for each, either remove the manifest row entirely or change its `status` to a new `removed` value (owner picks one).
- Pre-flight: grep `rg -l -F '<name>'` for each before deletion — if any source file (not test) still hard-codes the name, fix that source file in the same PR or pull it into a follow-up.
- Risk: medium. Catalog tests are the only real surface.
- Depends on: nothing.

**PR-2** — `chore(agents): remove 10 merged + 2 deprecated agents`
- Type: `chore` (deletion)
- Touches: `src/agents/definitions.ts` (12 entries), 12 `prompts/*.md`, possibly `src/agents/__tests__/definitions.test.ts`
- Scope: remove the 10 `merged` agents (api-reviewer, quality-reviewer, style-reviewer, performance-reviewer, quality-strategist, qa-tester, product-manager, product-analyst, ux-researcher, information-architect) and the 2 `deprecated` agents (security-reviewer, build-fixer) from both `AGENT_DEFINITIONS` and the `prompts/` tree. Keep the manifest rows as `merged → <canonical>` for upgrade-path stability.
- Pre-flight: grep each agent name in `skills/*/SKILL.md` — they should not appear in any active skill body. If they do, that's actually an M2 follow-up — bring it into this PR or split.
- Risk: medium. Some agents may still be in lint tests as expected entries.
- Depends on: PR-1 (so the cleanup is a single bloat-removal phase rather than two interleaved ones).

### Phase B — Inventory anomaly resolution

**PR-3** — `chore(catalog): add wiki to manifest OR remove skills/wiki`
- Type: `chore` (catalog) OR `chore` (deletion)
- Touches: `src/catalog/manifest.json` + `src/catalog/__tests__/` (one row OR a directory removal + test rule)
- Scope: resolve anomaly A1. Default recommendation in `bloat-audit.md` is ADD the row. Owner picks.
- Depends on: nothing (can land before, during, or after PR-1/PR-2). Listed here for the sequence.

### Phase C — Connectivity quick wins (docs-only)

These are all SKILL.md edits. They can land as a single PR or split — but they should land *after* Phase A so the editor isn't writing references to dead skills.

**PR-4** — `docs(skills): wire orphan-ish surfaces into their neighbors`
- Type: `docs`
- Touches: `skills/{performance-goal,omx-setup,doctor,configure-notifications,autopilot,code-review,analyze,ralplan,design}/SKILL.md` (≈9 single-line additions per Q1–Q9)
- Scope: apply Q1 through Q9 from § 2.1.
- Risk: low. Pure documentation.
- Depends on: PR-1 (so `help` is gone before we'd cross-link from it), PR-2 (so we're not referencing a now-removed agent like `qa-tester`).

### Phase D — Strategic decisions (one PR each, owner-routed)

These do NOT have a default recommendation in this document. Each lands as its own owner-approved PR.

**PR-5 (optional)** — `refactor(agents): merge prometheus-strict triple into one composite` (S2) — only if owner picks the composite option.

**PR-6 (optional)** — `refactor(agents): promote team-executor to active` (S3) — only if owner decides.

**PR-7 (optional)** — `chore(catalog): drop legacy configure-* merged rows` (S1) — only after ≥2 more releases.

**PR-8 (optional)** — `refactor(skills): fold performance-goal into ultragoal --performance` (S6) — only if owner decides.

### Dependency graph

```text
PR-1 (chore: delete tombstones) ───┐
                                   ├──► PR-4 (docs: connectivity quick wins)
PR-2 (chore: delete merged agents)─┘
PR-3 (chore: resolve wiki anomaly) — independent, can land anywhere

PR-5..8 — owner-routed, no fixed sequence among themselves; can land after PR-4
         or independently if their scope doesn't overlap PR-4 edits.
```

---

## Section 4 — Risk + verification per PR

For each PR above, the minimum verification before landing:

| PR | verification |
|----|--------------|
| PR-1 | `npm run lint:deps` (optional), `npm test -- src/catalog` (catalog tests), `npm test -- src/hooks/__tests__/skill-catalog-hygiene` to ensure the tombstone removal does not break the hygiene contract. |
| PR-2 | `npm test -- src/agents`, `npm test -- src/cli/__tests__/setup-prompts-overwrite` (because that test enumerates expected prompt files), and a manual `omx setup --dry-run` if reachable. |
| PR-3 | If adding the row: re-run `src/catalog/__tests__/schema.test.ts`. If removing the dir: also re-run any `wiki` prompt enumeration test. |
| PR-4 | Pure docs. CI should be a no-op other than markdown lint. |
| PR-5..8 | Owner-routed; verification scope decided per PR. |

---

## Section 5 — What this roadmap deliberately does NOT do

- It does not propose deleting the `configure-{discord,telegram,slack,openclaw}` merged manifest rows. Those are intentional upgrade-path absorbers. Removing them is a separate strategic decision (S1).
- It does not propose adding new skills. The owner explicitly asked for bloat triage + connectivity; new skills are out of scope.
- It does not propose touching `src/agents/policy.ts` or `src/agents/native-config.ts` beyond what is already covered by removing the merged/deprecated entries from `AGENT_DEFINITIONS`. Those files' logic is sound; only the data they operate on is shrinking.
- It does not propose rewriting any of the 7 STREAMLINE (optional) skills. Per `bloat-audit.md`, those are deferred until after the tombstone deletion lands so the diff stays small.
- It does not propose any change to `./prompts/explore-harness.md`, `./prompts/sisyphus-lite.md`, or `./prompts/team-orchestrator.md`. They are intentionally non-installable per `src/agents/policy.ts`'s `NON_NATIVE_AGENT_PROMPT_ASSETS`.

---

## Section 6 — Quick reference

Counts at a glance (drawn from `bloat-audit.md` § Summary):

- Skills to **DEPRECATE**: 16 → PR-1
- Agents to **CONSOLIDATE**: 10 → PR-2 (merged)
- Agents to **DEPRECATE**: 2 → PR-2 (deprecated)
- Skills with manifest anomaly: 1 (`wiki`) → PR-3
- Connectivity quick wins: 9 → PR-4
- Strategic decisions outstanding: 6 (S1–S6) → PR-5..8 (optional)

After PR-1 through PR-4 land, the surface is:

- ~30 skills (currently 50 catalog entries; 46 on-disk → 30 on-disk after tombstone deletion).
- ~21 agents (currently 33 in `AGENT_DEFINITIONS` → 21 after consolidation/deprecation).
- Zero on-disk skills missing from the manifest (anomaly A1 closed).
- Every active skill has at least one cross-skill link (or is intentionally below the cross-link layer).

That is the target shape this roadmap moves toward.

---

*Generated for owner review. Re-run by regenerating `notes/combined.json` and recomputing the orphan analysis.*
