---
name: code-review
description: Run a comprehensive code review
---

# Code Review Task Card

Use this explicit opt-in for a merge-readiness review. Shared operating invariants
live in `templates/AGENTS.md`; this card only defines review-specific behavior.

## When to use

- The user asks for a code review or quality/security assessment.
- A change is ready for review before merge, or a major feature needs an independent review.
- Do not activate this card for implementation, broad planning, or automatic cleanup.

## Inputs

- Scope: the requested files, commit, PR, or whole diff.
- Requirements/specification, acceptance criteria, and relevant test/CI evidence.
- Existing review artifacts and known risks, if any.
- If the user says `continue`, advance the current verified review step rather than restarting discovery.

Start by recording the scope:

```sh
git status --short
git diff --stat
git diff -- <scope>
```

## Continuation Decision Table

When a user requests `continue` or provides existing artifacts, check the source binding and decide the next step:

| Condition | Action |
|-----------|--------|
| **Fresh Review** (no prior receipt, OR source/requirements/gates changed) | Launch both code-reviewer and architect lanes in parallel on clean contexts. Treat prior artifacts as context only; do not reuse evidence. |
| **Resuming Missing Lane** (one lane has evidence, other missing, source/requirements/gates unchanged) | Re-launch the missing lane only. Carry prior evidence from the complete lane. |
| **Resuming Missing Validation** (both lanes returned, validation incomplete, source/requirements/gates unchanged) | Collect missing validation inputs/results. Reuse lane evidence. |
| **Repair Re-review** (implementation changed source after prior review, authorized repair owner confirmed) | Re-launch both lanes on the revised scope. Include prior findings as context; preserve dispositions unless new evidence justifies reopening. Carry repair authorization through the review. |
| **Complete Evidence** (all lanes returned, all validation complete, source/requirements/gates unchanged) | Return the existing scoped result and stop. No re-review needed. |

**Binding Rules**: A source-bound receipt tracks scope identity (commit, uncommitted changes, file hashes), requirements, configured gates, and lane results. Missing or unverifiable bindings (stale/unbound artifacts, changed source not signed by repair authorization) prevent evidence reuse. Invalidation triggers a fresh review; partial evidence loss triggers lane resumption, not full restart.

## Execution

1. Identify changed files and review boundaries; do not silently widen the scope.
2. Launch the `code-reviewer` and `architect` agents in parallel. Both lanes run in parallel on a clean context with explicit scope and artifacts. If either lane cannot be launched or does not return evidence, report `independent review unavailable`; do **not** substitute the current/authoring lane, and do **not** approve or mark the review merge-ready.
3. Respect the user's current model and reasoning/effort selection. Do not pass `model` or `reasoning_effort` overrides in the built-in `code-reviewer` and `architect` review-lane calls. A configured custom quality gate may override its own subagent model as described below.

```text
task(
  agent_type="code-reviewer",
  prompt="CODE REVIEW TASK

Review the supplied scope for spec compliance, security, quality, performance, and maintainability.
Return files reviewed, severity-rated findings with file:line evidence and concrete fixes,
and a recommendation: APPROVE / REQUEST CHANGES / COMMENT. Do not review architecture.
Scope: [scope and artifacts]"
)

task(
  agent_type="architect",
  prompt="ARCHITECTURE / DEVIL'S-ADVOCATE REVIEW TASK

Review the same scope for boundaries, interfaces, hidden coupling, long-term tradeoffs,
and the strongest counterargument against approval. Return file:line evidence,
recommendations, and Architectural Status: CLEAR / WATCH / BLOCK.
Scope: [scope and artifacts]"
)
```

## Custom code-review quality gates

After the built-in independent reviews, read `.omx-config.json` `qualityGates."code-review"` with `omx quality-gates list --stage code-review --json`. Each gate specifies `skill`, `mode` (`advisory` or `blocking`), and optional `model`; for example `{"qualityGates":{"code-review":[{"skill":"security-audit","mode":"blocking"}]}}`.

Spawn each configured gate skill as a separate subagent with the same scoped diff, requirements, validation evidence, and completed built-in reviews. Honor an optional `model` only for that custom gate. Await results before final synthesis; record each skill, mode, verdict, findings, and evidence in the review receipt. Advisory findings, including unavailable advisory reviews, remain visible but do not independently block approval. A blocking gate that does not approve or cannot return evidence forces **REQUEST CHANGES** and prevents merge-ready status or downstream clean-review progression. Re-review the corrected scope and re-run gates before clearing that blocker; the standalone review remains read-only. Custom gates never replace the required `code-reviewer` and `architect` lanes. An empty gate list preserves the existing review flow.

## Review taxonomy

- `code-reviewer` checks **Security**, **Code Quality**, **Performance**, **Best Practices**, and **Maintainability**.
- Rate each finding: **CRITICAL** (security or data-loss blocker), **HIGH** (bug/major smell), **MEDIUM** (important improvement), or **LOW** (style/suggestion).
- `architect` checks explicit boundaries/interfaces, hidden coupling, long-horizon tradeoffs, and devil's-advocate concerns. Status is **CLEAR**, **WATCH** (non-blocking concern), or **BLOCK** (merge blocker).
- Every finding names `file:line`, issue, risk, and a concrete fix; distinguish facts from suggestions.

## State/HUD Phase Contract

- Standalone `$code-review` relies on hook-owned `skill-active-state.json` (`skill:"code-review"`, `phase:"planning"`); do not create `code-review-state.json`.
- Inside Autopilot, keep `mode:"autopilot"` active with `current_phase:"code-review"` / skill-active `phase:"code-review"`; do not activate a peer workflow.
- On clean review, persist the artifact under Autopilot `handoff_artifacts.code_review` before moving to `ultraqa`. On non-clean review, persist findings and use `rework` or `ralplan` as appropriate.

```sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"code-review"}' --json
```

## Final Synthesis and gate

### Architectural Status Contract

Combine the `code-reviewer` recommendation and architect status. Approval requires explicit evidence from both independent lanes; missing or failed delegation is a blocking unavailable-review state, not an approval fallback. The final report must make architect blockers impossible to miss.

- If architect status is **BLOCK**, final recommendation is **REQUEST CHANGES**.
- Else if `code-reviewer` recommendation is **REQUEST CHANGES**, final recommendation is **REQUEST CHANGES**.
- Else if architect status is **WATCH**, final recommendation is **COMMENT**.
- Else final recommendation follows the `code-reviewer` lane.

Approval criteria: **APPROVE** only when `code-reviewer` returns APPROVE, architect status is `CLEAR`, both independent lanes returned evidence, and every configured blocking quality gate passes. **REQUEST CHANGES** for a blocker, unresolved high/critical finding, unavailable lane, or non-passing/unavailable blocking quality gate. **COMMENT** may record non-blocking findings.

Do not self-review as a fallback. If the `code-reviewer` or `architect` path is missing, unavailable, skipped, or fails, block approval until independent lane evidence exists. On the supported `omx ralph` CLI compatibility path, findings may trigger automatic fix follow-up without another permission prompt; plain `code-review` itself remains read-only and does **not** promise auto-fix.

## Evidence/output contract

Return a concise report containing:

```text
CODE REVIEW REPORT
Files Reviewed: <count>
Total Issues: 0
Architectural Status: CLEAR | WATCH | BLOCK
CRITICAL (0) | HIGH (0) | MEDIUM (0) | LOW (0)
Findings: file:line -> issue, risk, concrete fix (or none)
ARCHITECTURE WATCHLIST: concern, status, recommendation (or none)
- code-reviewer recommendation: COMMENT
- architect status: WATCH
- final recommendation: COMMENT
RECOMMENDATION: COMMENT
```

Replace the illustrative counts and verdict with observed values. Include scope,
lane evidence/artifact references, unresolved risks, and validation gaps.

## Source-Bound Review Receipt

When a review completes or a user requests continuation, record a source-bound receipt that binds the review result to its input context. This receipt is the basis for deciding whether to reuse evidence or perform a fresh review.

**Receipt Structure**:

```text
SOURCE-BOUND REVIEW RECEIPT

REVIEW SCOPE
  Files Reviewed: <count>
  Changed Lines: <+/->
  Boundaries: <scope description>

SOURCE IDENTITY
  Base Commit: <commit hash>
  Uncommitted Changes: <yes|no> [file hashes if present]
  Source Binding: <valid|stale|unbound>

REQUIREMENTS & GATES
  Specification: [reference or summary]
  Acceptance Criteria: [reference or summary]
  Test/CI Evidence: [references]
  Configured Quality Gates: [list of blocking/advisory gates]

LANE RESULTS
  code-reviewer:
    Recommendation: APPROVE | REQUEST CHANGES | COMMENT
    Finding Severity: CRITICAL (N) | HIGH (N) | MEDIUM (N) | LOW (N)
    Artifact: [reference or hash]
    Status: complete | unavailable
  
  architect:
    Status: CLEAR | WATCH | BLOCK
    Finding Severity: CRITICAL (N) | HIGH (N) | MEDIUM (N) | LOW (N)
    Artifact: [reference or hash]
    Status: complete | unavailable
  
  [custom gates]:
    Gate Name: <skill name>
    Mode: blocking | advisory
    Verdict: pass | fail | unavailable
    Artifact: [reference or hash]
    Status: complete | unavailable

VALIDATION
  Inputs Recorded: [list of validation requirements met]
  Validation Results: [status of each requirement]
  Validation Status: complete | incomplete

FINDINGS & GAPS
  Unresolved High/Critical: [count and list]
  Evidence Gaps: [any missing evidence from required lanes or gates]
  Blockers: [any blocking conditions preventing approval]

FINAL RECOMMENDATION
  Recommendation: APPROVE | REQUEST CHANGES | COMMENT
  Merge-Ready: yes | no
  Binding Status: bound | unbound
```

**Invalidation Triggers**: The receipt becomes invalid if:
- Base commit or uncommitted changes differ from the initial review (source changed)
- Requirements or acceptance criteria are updated
- Configured quality gates change (gates added, removed, or mode changed)
- Validation inputs/results are unavailable or stale
- Required lanes (code-reviewer or architect) are missing or unavailable

**Reuse Rules**: Evidence may be reused across continuation requests only if all binding conditions match and the receipt status is `bound`. A `stale` or `unbound` receipt requires fresh review. Missing or unverifiable bindings never establish approval.

## Exit condition

Stop when the scoped diff has two independent lane results and a deterministic final
recommendation. Report `APPROVE` only under the approval criteria; otherwise leave a
bounded `REQUEST CHANGES`, `COMMENT`, or unavailable-review result. Never claim
merge-ready without the required evidence.

## GitHub PR publication

When the user asks to publish a review on a GitHub PR, publish a **PR review with
inline review comments**, not a single issue comment. A review is a GitHub review
submission; an inline review comment is a `pulls/{n}/comments` object anchored to
the diff and linked by `pull_request_review_id`.

- Bind to the reviewed source: resolve the PR head SHA, confirm it matches the
  reviewed commit, and pass it as `commit_id`. Do not publish against a changed
  head; re-review and bind a new review to the new SHA instead.
- Use the REST reviews endpoint (`POST /repos/{owner}/{repo}/pulls/{number}/reviews`)
  with `commit_id`, `event` (`APPROVE` | `COMMENT` | `REQUEST_CHANGES`), a readable
  summary `body`, and `comments[]`. `gh pr review` submits a body-only review; use
  the REST endpoint when inline comments are required.
- Each line-anchored finding is an inline comment:
  `{ path, line, side: "RIGHT", start_line?, body }`. Verify both endpoints exist on
  the new side of the PR diff; use `start_line` for a range. Findings without a
  stable line anchor belong in the review body; do not invent a line.
- The body carries scope, reviewed commit, finding counts, architectural status,
  validation, final recommendation, and a pointer to the inline findings.
- Publish findings supported by the code, tests, or CLI contract; mark hypotheses as
  hypotheses. Keep internal receipts, raw gate/subagent logs, secrets, and
  unsupported claims about external services out of the public review unless the
  user explicitly asks for them.
- Match `event` to the final recommendation; never APPROVE without the approval
  criteria above.
- Verify after submission: review state, `pull_request_review_id` on comments, and
  review threads (`path`/`line`). The REST API can delete only pending reviews; if a
  submitted body-only review already exists, update its body to point at the
  structured review or supersede it instead of duplicating content.

## Quality Gates

Custom quality gates can be configured for the code-review stage via `.omx-config.json` under `qualityGates."code-review"`. See [Custom Quality Gates Configuration](https://github.com/Yeachan-Heo/oh-my-codex/blob/dev/docs/reference/omx-config-quality-gates.md).
