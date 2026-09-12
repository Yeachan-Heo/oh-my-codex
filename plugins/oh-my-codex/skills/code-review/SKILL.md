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

## Execution

1. Identify changed files and review boundaries; do not silently widen the scope.
2. Launch the `code-reviewer` and `architect` agents in parallel. Both lanes run in parallel on a clean context with explicit scope and artifacts. If either lane cannot be launched or does not return evidence, report `independent review unavailable`; do **not** substitute the current/authoring lane, and do **not** approve or mark the review merge-ready.
3. Respect the user's current model and reasoning/effort selection. Do not pass `model` or `reasoning_effort` overrides in review-lane calls.

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

Approval criteria: **APPROVE** only when `code-reviewer` returns APPROVE, architect status is `CLEAR`, and both independent lanes returned evidence. **REQUEST CHANGES** for a blocker, unresolved high/critical finding, or unavailable lane. **COMMENT** may record non-blocking findings.

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

## Exit condition

Stop when the scoped diff has two independent lane results and a deterministic final
recommendation. Report `APPROVE` only under the approval criteria; otherwise leave a
bounded `REQUEST CHANGES`, `COMMENT`, or unavailable-review result. Never claim
merge-ready without the required evidence.
