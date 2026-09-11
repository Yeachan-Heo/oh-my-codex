# Measuring OMX's maintenance surface

Use the existing inventory; do not infer quality from a LOC target:

```sh
npm run build
node dist/scripts/prompt-inventory.js --json > /tmp/omx-inventory.json
git rev-parse HEAD
node --test dist/scripts/__tests__/prompt-inventory.test.js
node dist/scripts/prompt-inventory.js --check
```

Run from a clean worktree for revision-to-revision comparisons and record its commit
and dirty status alongside the report. `--root <path>` measures that filesystem,
including untracked files in the selected canonical source directories; it does not
silently claim to be a Git snapshot. The command reads files and writes only stdout.

## Schema and categories

The additive `repositorySize` object has `schemaVersion: 1`, `groups`, and the ten
`largestNonTestFiles`, ordered by descending physical lines then by path.
Each group contains `files`, `physicalLines`, and raw `bytes`:

| Group | Definition |
| --- | --- |
| `nonTestSource` | `src/**/*.{ts,js,mjs,sh}`, excluding test classification below; includes maintenance/build/smoke scripts, not just shipped runtime |
| `testSource` | Same extensions under `__tests__`, or filenames containing `.test.` / `.spec.` |
| `rustSourceIncludingTests` | `crates/**/*.rs`; includes inline and separate Rust tests |
| `skillCards` | Canonical `skills/<name>/SKILL.md`, including sunset cards; not an active-skill count |
| `agentPrompts` | Canonical `prompts/*.md`, including non-installable prompt assets |
| `agentTemplate` | `templates/AGENTS.md`; not the local installed/generated root file |

Physical lines include comments/blanks, count CRLF as one newline, and do not count
a trailing newline as an extra empty line. Empty files contribute zero lines.
Nested hidden directories, `generated`, `node_modules`, `dist`, `target`, and
symlink entries are excluded. Plugin mirrors, local `.codex`/`.agents` installations,
and runtime artifacts are not canonical source. No filename-based heuristic can
identify every generated file; these are explicit path-based categories.

Existing `totals` and `surfaces` retain their historical prompt-inventory semantics.
They include docs and embedded source surfaces and count trailing empty lines.
`approximateTokens` is a lexical word/punctuation estimate, **not a tokenizer count,
actual injected context, or the total tokens consumed by a task**. Do not compare
these legacy line totals directly with the new physical-line totals.

## Interpreting a cleanup

Compare category deltas and changed hotspots, then run the affected routing/skill
contracts. The ordinary-task routing corpus (delivered in the companion hook-cleanup
PR) tests classification and actual workflow-state effects with ordinary prompts,
quoted mentions, and explicit workflow requests. It is not a model-quality benchmark.

Record test passes, failures, unnecessary workflow activation, and instruction-size
deltas together. Do not fail CI merely because source or tests grew. This inventory
adds no model calls, runtime instrumentation, dependencies, or flaky latency budgets.
Actual task success, injected tokens, and hook latency require a separate controlled
end-to-end run with a recorded model, environment, corpus, and repeated measurements.

## Initial reference snapshot

Measured from a clean archive of `dev` commit
`5190a9dcea2cf7e5f1b2b6be8daa891215596e82` (2026-09-09), using schema 1:

| Category | Files | Physical lines |
| --- | ---: | ---: |
| Non-test source | 400 | 199,310 |
| Test source | 444 | 247,047 |
| Rust, including tests | 37 | 15,964 |
| Skill cards | 29 | 2,657 |
| Agent prompts | 32 | 2,189 |
| Agent template | 1 | 229 |

The native-hook hotspot was 23,077 lines. These are a dated reference, not frozen
CI limits. Compare future reports against the same categories and source revision.
